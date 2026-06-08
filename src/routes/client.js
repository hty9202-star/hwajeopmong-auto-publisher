/**
 * 광고주(Client) API 라우트 핸들러
 * server.js에서 분리된 모듈
 */

import { CONTENT_TYPES } from '../config.js';
import { calculateGeoScore, calculateEeatScore } from '../content-generator.js';
import { publishToWordPress, updateWordPressPost } from '../wordpress-publisher.js';
import { contentQueue, publishLogs, publishedTopics, settings, topics as topicsDB } from '../supabase-client.js';
import { env } from '../lib/env.js';
import { jsonRes, parseBody, getHtml, saveErrorLog } from '../lib/helpers.js';
import { verifyToken, CLIENT_TOKENS, genToken } from '../lib/auth.js';
import { autoPublish, getNextPublishTime } from '../lib/publisher.js';

/**
 * 광고주 라우트 처리
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} method
 * @param {URL} url
 * @returns {Promise<boolean>} 처리했으면 true, 아니면 false
 */
export async function handleClientRoutes(req, res, pathname, method, url) {

  // --- 광고주 HTML 페이지 ---
  if (pathname === '/client/login' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtml('client-login.html'));
    return true;
  }
  if (pathname === '/client' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(getHtml('client-dashboard.html'));
    return true;
  }

  // --- Client API: Login ---
  if (pathname === '/api/client/login' && method === 'POST') {
    try {
      const parsed = await parseBody(req);
      const cid = process.env.CLIENT_ID || 'hwajeopmong';
      const cpw = process.env.CLIENT_PASSWORD;
      if (!cpw) { jsonRes(res, { error: 'CLIENT_PASSWORD 환경변수가 설정되지 않았습니다' }, 500); return true; }
      if (parsed.id === cid && parsed.password === cpw) {
        const tk = genToken();
        CLIENT_TOKENS.set(tk, { id: parsed.id, at: new Date().toISOString() });
        jsonRes(res, { success: true, token: tk });
      } else {
        jsonRes(res, { success: false, error: 'Invalid credentials' }, 401);
      }
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  // --- Client API: Status (토큰 인증 필요) ---
  if (pathname === '/api/client/status' && method === 'GET') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    try {
      const publishSettings = await settings.get('publish') || {};
      const allTopics = await topicsDB.getAll();
      const topicCount = allTopics ? allTopics.length : 0;
      const total = topicCount * CONTENT_TYPES.length;
      const totalTarget = publishSettings.totalTarget || total;

      // 발행 건수
      let periodPublished = 0;
      if (publishSettings.startDate) {
        const periodEnd = publishSettings.endDate || '2099-12-31';
        const periodLogs = await publishLogs.getByDateRange(publishSettings.startDate, periodEnd);
        periodPublished = (periodLogs || []).filter(function(item) {
          return (item.status === 'published' || item.status === 'success') && !item.is_test;
        }).length;
      } else {
        const publishedComboIds = await publishedTopics.getComboIds();
        periodPublished = publishedComboIds.length;
      }

      const nextPublishTime = await getNextPublishTime();

      // 발행 기간 정보 (KST)
      const kstToday = new Date(Date.now() + 9*60*60*1000);
      const todayStr = kstToday.getUTCFullYear() + '-' + String(kstToday.getUTCMonth()+1).padStart(2,'0') + '-' + String(kstToday.getUTCDate()).padStart(2,'0');
      let publishPeriod = null;
      if (publishSettings.startDate || publishSettings.endDate) {
        const startDate = publishSettings.startDate || null;
        const endDate = publishSettings.endDate || null;
        let status = 'active';
        let daysLeft = null;
        if (startDate && todayStr < startDate) {
          status = 'waiting';
          daysLeft = Math.ceil((new Date(startDate) - new Date(todayStr)) / (1000*60*60*24));
        } else if (endDate) {
          daysLeft = Math.ceil((new Date(endDate) - new Date(todayStr)) / (1000*60*60*24));
          if (daysLeft < 0) status = 'expired';
          else if (daysLeft === 0) status = 'dday';
          else if (daysLeft <= 7) status = 'expiring';
        }
        publishPeriod = { startDate: startDate, endDate: endDate, status: status, daysLeft: daysLeft };
      }

      jsonRes(res, {
        content: { published: periodPublished, totalTarget: totalTarget },
        nextPublishTime: nextPublishTime,
        publishPeriod: publishPeriod,
      });
    } catch (e) {
      console.error('[Client Status] 에러:', e.message);
      jsonRes(res, { error: e.message }, 500);
    }
    return true;
  }

  // --- Client API: Contents List (with pagination) ---
  if (pathname === '/api/client/contents' && method === 'GET') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    try {
      const params = Object.fromEntries(url.searchParams);
      const searchTerm = (params.search || '').replace(/[%_]/g, '');
      const result = await contentQueue.search({
        page: parseInt(params.page) || 1,
        limit: Math.min(parseInt(params.limit) || 10, 100),
        search: searchTerm,
        status: params.status || '',
        sort: params.sort || 'latest',
      });
      const counts = await contentQueue.getCounts();
      jsonRes(res, { data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages, counts: counts });
    } catch (e) {
      console.error('[Client Contents] 에러:', e.message);
      jsonRes(res, { error: e.message }, 500);
    }
    return true;
  }

  // --- Client API: Approve ---
  if (pathname.match(/^\/api\/client\/contents\/[^/]+\/approve$/) && method === 'POST') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    const itemId = pathname.split('/')[4];
    const item = await contentQueue.getById(itemId);
    if (!item || item.status !== 'pending') { jsonRes(res, { error: 'Not found' }, 404); return true; }

    try {
      const wpR = await publishToWordPress(env, {
        title: item.title,
        content: item.content,
        excerpt: item.excerpt,
        metaDescription: item.meta_description,
        focusKeyphrase: item.topic_name ? `${item.topic_name} 한방치료` : '',
        heroImage: item.hero_image_url ? { url: item.hero_image_url } : null,
        category: item.category,
        tags: item.tags,
        schemas: item.schemas,
      }, 'publish');

      await contentQueue.updateStatus(itemId, 'approved', {
        wp_post_id: wpR.id,
        wp_post_url: wpR.link,
      });

      await publishedTopics.add(item.combo_id, item.topic_id, item.content_type_id);

      await publishLogs.updateByQueueId(itemId, {
        status: 'published',
        wp_post_id: wpR.id,
        wp_post_url: wpR.link,
        published_at: new Date().toISOString(),
      });

      jsonRes(res, { success: true, wpLink: wpR.link });
    } catch (e) {
      // WP 발행 실패 시 wp_failed로 마킹 (콘텐츠 유실 방지)
      try {
        await contentQueue.updateStatus(itemId, 'wp_failed');
        await saveErrorLog('wp_publish_failed', e);
      } catch (logErr) { console.error('[WP 발행 실패] 상태 업데이트도 실패:', logErr); }
      jsonRes(res, { error: 'WordPress 발행 실패: ' + e.message + ' (재시도 가능)' }, 500);
    }
    return true;
  }

  // --- Client API: Retry WP publish (wp_failed → 재시도) ---
  if (pathname.match(/^\/api\/client\/contents\/[^/]+\/retry$/) && method === 'POST') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    const itemId = pathname.split('/')[4];
    const item = await contentQueue.getById(itemId);
    if (!item || item.status !== 'wp_failed') { jsonRes(res, { error: 'Not found or not retryable' }, 404); return true; }

    try {
      const wpR = await publishToWordPress(env, {
        title: item.title,
        content: item.content,
        excerpt: item.excerpt,
        metaDescription: item.meta_description,
        focusKeyphrase: item.topic_name ? `${item.topic_name} 한방치료` : '',
        heroImage: item.hero_image_url ? { url: item.hero_image_url } : null,
        category: item.category,
        tags: item.tags,
        schemas: item.schemas,
      }, 'publish');

      await contentQueue.updateStatus(itemId, 'approved', {
        wp_post_id: wpR.id,
        wp_post_url: wpR.link,
      });

      await publishedTopics.add(item.combo_id, item.topic_id, item.content_type_id);

      await publishLogs.updateByQueueId(itemId, {
        status: 'published',
        wp_post_id: wpR.id,
        wp_post_url: wpR.link,
        published_at: new Date().toISOString(),
      });

      jsonRes(res, { success: true, wpLink: wpR.link });
    } catch (e) {
      await saveErrorLog('wp_retry_failed', e).catch(function() {});
      jsonRes(res, { error: 'WordPress 재시도 실패: ' + e.message }, 500);
    }
    return true;
  }

  // --- Client API: Re-sync to WordPress (수정 후 WP 동기화 실패 → DB 내용으로 재동기화) ---
  if (pathname.match(/^\/api\/client\/contents\/[^/]+\/sync-wp$/) && method === 'POST') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    const itemId = pathname.split('/')[4];
    const item = await contentQueue.getById(itemId);
    if (!item) { jsonRes(res, { error: 'Not found' }, 404); return true; }
    if (!item.wp_post_id) { jsonRes(res, { error: 'WordPress에 발행되지 않은 콘텐츠입니다' }, 400); return true; }

    try {
      const wpResult = await updateWordPressPost(env, item.wp_post_id, {
        title: item.title,
        content: item.content,
        excerpt: item.excerpt,
        tags: item.tags,
        metaDescription: item.meta_description,
      });
      // 동기화 성공 기록
      await publishLogs.updateByQueueId(itemId, { edited_at: new Date().toISOString() }).catch(function() {});
      jsonRes(res, { success: true, message: 'WordPress 재동기화 완료', wpLink: wpResult ? wpResult.link : (item.wp_post_url || null) });
    } catch (e) {
      await saveErrorLog('WP재동기화실패', new Error('[ID ' + itemId + '] ' + e.message)).catch(function() {});
      jsonRes(res, { error: 'WordPress 재동기화 실패: ' + e.message }, 500);
    }
    return true;
  }

  // --- Client API: Reject ---
  if (pathname.match(/^\/api\/client\/contents\/[^/]+\/reject$/) && method === 'POST') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    const itemId = pathname.split('/')[4];
    const item = await contentQueue.getById(itemId);
    if (!item || item.status !== 'pending') { jsonRes(res, { error: 'Not found' }, 404); return true; }

    await contentQueue.updateStatus(itemId, 'rejected');

    await publishLogs.updateByQueueId(itemId, {
      status: 'rejected',
    });

    jsonRes(res, { success: true });

    // 같은 주제로 재생성 (기간 체크 우회)
    const rejectTopics = await topicsDB.getAll();
    const rejectedTopic = (rejectTopics || []).find(function(t) { return t.id === item.topic_id; });
    const rejectedContentType = CONTENT_TYPES.find(function(ct) { return ct.id === item.content_type_id; });
    autoPublish({
      bypassPeriodCheck: true,
      forceTopic: rejectedTopic || null,
      forceContentType: rejectedContentType || null,
      republishedFrom: { id: itemId, title: item.title, topic_name: item.topic_name, content_type_name: item.content_type_name, rejected_at: item.created_at || new Date().toISOString() },
    }).catch(function(e) { console.error('Regen error:', e); saveErrorLog('재생성발행', e); });
    return true;
  }

  // --- Client/Admin API: Edit (승인된 콘텐츠 수정) ---
  if (pathname.match(/^\/api\/client\/contents\/[^/]+\/edit$/) && method === 'POST') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    const itemId = pathname.split('/')[4];
    const item = await contentQueue.getById(itemId);
    if (!item) { jsonRes(res, { error: 'Not found' }, 404); return true; }

    const editData = await parseBody(req).catch(function() { return {}; });
    if (!editData.title && !editData.content) {
      jsonRes(res, { error: '수정할 내용이 없습니다' }, 400);
      return true;
    }

    try {
      // 1. Supabase DB 업데이트
      const dbUpdates = {};
      if (editData.title) dbUpdates.title = editData.title;
      if (editData.content) dbUpdates.content = editData.content;
      // 태그: 빈 배열이면 원본 유지, 실제 값이 있을 때만 업데이트
      if (editData.tags && Array.isArray(editData.tags) && editData.tags.length > 0) {
        dbUpdates.tags = editData.tags;
      }
      if (editData.meta_description) dbUpdates.meta_description = editData.meta_description;
      if (editData.excerpt) dbUpdates.excerpt = editData.excerpt;

      // 1-b. 품질 점수 재계산
      const updatedContent = editData.content || item.content || '';
      const updatedTitle = editData.title || item.title || '';
      const updatedMetaDesc = editData.meta_description || item.meta_description || '';
      try {
        const geoResult = calculateGeoScore(updatedContent, updatedTitle, updatedMetaDesc, item.faq || [], item.schemas || null);
        const eeatResult = calculateEeatScore(updatedContent, updatedTitle);
        dbUpdates.geo_score = geoResult.score;
        dbUpdates.eeat_score = eeatResult.score;
        console.log(`[수정 API] 품질 점수 재계산: GEO ${geoResult.score}, E-E-A-T ${eeatResult.score}`);
      } catch (scoreErr) {
        console.error('[수정 API] 점수 재계산 실패 (무시):', scoreErr.message);
      }

      // 1-c. 광고주 수정 이력 스냅샷 (변경 표시용 — 수정 전/후 쌍 저장, 최근 3회 보관)
      try {
        const titleChanged = editData.title && editData.title !== item.title;
        const contentChanged = editData.content && editData.content !== item.content;
        if (titleChanged || contentChanged) {
          const history = Array.isArray(item.edit_history) ? item.edit_history : [];
          history.push({
            edited_at: new Date().toISOString(),
            edited_by: 'client',
            before: { title: item.title, content: item.content },
            after: { title: updatedTitle, content: updatedContent },
          });
          dbUpdates.edit_history = history.slice(-3);
        }
      } catch (histErr) {
        console.error('[수정 API] 수정 이력 저장 실패 (무시):', histErr.message);
      }

      console.log(`[수정 API] DB 업데이트 시작: ID ${itemId}, 필드: ${Object.keys(dbUpdates).join(', ')}`);
      await contentQueue.updateContent(itemId, dbUpdates);
      console.log(`[수정 API] DB 업데이트 완료: ID ${itemId}`);

      // 2. 이미 WordPress에 발행된 글이면 WP도 동기화
      let wpResult = null;
      let wpError = null;
      if (item.wp_post_id) {
        try {
          const wpTags = (editData.tags && Array.isArray(editData.tags) && editData.tags.length > 0) ? editData.tags : item.tags;
          wpResult = await updateWordPressPost(env, item.wp_post_id, {
            title: editData.title || item.title,
            content: editData.content || item.content,
            excerpt: editData.excerpt || item.excerpt,
            tags: wpTags,
            metaDescription: editData.meta_description || item.meta_description,
          });
        } catch (wpErr) {
          console.error('[수정 API] WordPress 동기화 실패 (DB는 저장됨):', wpErr.message);
          wpError = wpErr.message;
          // 동기화 실패를 영구 에러로그에 기록 (대시보드에서 확인 + '/sync-wp'로 재시도 가능)
          await saveErrorLog('수정_WP동기화실패', new Error('[ID ' + itemId + '] ' + wpErr.message + ' (DB는 저장됨, 재동기화 필요)')).catch(function() {});
        }
      }

      // 3. publish_logs에도 수정 기록 반영
      try {
        const logUpdates = { edited_at: new Date().toISOString() };
        if (editData.title) logUpdates.title = editData.title;
        await publishLogs.updateByQueueId(itemId, logUpdates);
      } catch (logErr) {
        console.error('[수정 API] publish_logs 업데이트 실패 (무시):', logErr.message);
      }

      let message = '콘텐츠 수정 완료';
      if (item.wp_post_id && wpResult) {
        message = '콘텐츠 수정 및 WordPress 동기화 완료';
      } else if (item.wp_post_id && wpError) {
        message = '콘텐츠 수정 완료 (WordPress 동기화 실패: ' + wpError + ')';
      } else if (!item.wp_post_id) {
        message = '콘텐츠 수정 완료 (WordPress 미발행 상태)';
      }

      jsonRes(res, {
        success: true,
        message: message,
        wpSynced: !!wpResult,
        wpError: wpError || null,
        wpLink: wpResult ? wpResult.link : (item.wp_post_url || null),
      });
    } catch (e) {
      console.error('[수정 API] 에러:', e.message, e.stack);
      saveErrorLog('수정API', e);
      jsonRes(res, { error: '콘텐츠 수정 중 오류: ' + e.message }, 500);
    }
    return true;
  }

  // --- Client/Admin API: Delete (반려된 콘텐츠만) ---
  if (pathname.match(/^\/api\/client\/contents\/[^/]+$/) && method === 'DELETE') {
    if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    const itemId = pathname.split('/')[4];
    const item = await contentQueue.getById(itemId);
    if (!item) { jsonRes(res, { error: 'Not found' }, 404); return true; }
    if (item.status !== 'rejected') {
      jsonRes(res, { error: '반려된 콘텐츠만 삭제할 수 있습니다' }, 400);
      return true;
    }
    await contentQueue.delete(itemId);
    jsonRes(res, { success: true });
    return true;
  }

  // 이 라우터에서 처리하지 않는 경로
  return false;
}
