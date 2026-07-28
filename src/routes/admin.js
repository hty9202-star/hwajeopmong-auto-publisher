/**
 * 관리자 API 라우트 핸들러
 * server.js에서 분리된 모듈
 */
import { CONTENT_TYPES, BRAND } from '../config.js';
import { calculateGeoScore, calculateEeatScore } from '../content-generator.js';
import { checkConnection, updatePostMetaViaBridge, updateWordPressPost } from '../wordpress-publisher.js';
import { contentQueue, publishLogs, publishedTopics, settings, topics as topicsDB, citationResults, testConnection as testSupabase } from '../supabase-client.js';
import { env } from '../lib/env.js';
import { jsonRes, parseBody, getHtml, saveErrorLog } from '../lib/helpers.js';
import { verifyAdminToken, genToken, saveToken } from '../lib/auth.js';
import { autoPublish, getIsPublishing, resolveNextTopic, getNextPublishTime, setupCronSchedule, activeCronJobs, getSchedulerEnabled, setSchedulerEnabled } from '../lib/publisher.js';
import { citationCronJob, lastCitationTrackTime } from '../lib/citation.js';

/**
 * 관리자 API 라우트 처리
 * @param {object} req - HTTP 요청
 * @param {object} res - HTTP 응답
 * @param {string} pathname - URL 경로
 * @param {string} method - HTTP 메서드
 * @param {URL} url - 파싱된 URL 객체
 * @returns {boolean} 라우트를 처리했으면 true, 아니면 false
 */
export async function handleAdminRoutes(req, res, pathname, method, url) {

  // Admin login page
  if (pathname === '/admin/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtml('admin-login.html'));
    return true;
  }

  // Admin login API
  if (pathname === '/api/admin/login' && method === 'POST') {
    try {
      const parsed = await parseBody(req);
      const adminId = process.env.ADMIN_ID || 'admin';
      const adminPw = process.env.ADMIN_PASSWORD;
      if (!adminPw) { jsonRes(res, { error: 'ADMIN_PASSWORD 환경변수가 설정되지 않았습니다' }, 500); return true; }
      if (parsed.id === adminId && parsed.password === adminPw) {
        const tk = genToken();
        await saveToken(tk, 'admin', parsed.id);
        jsonRes(res, { success: true, token: tk });
      } else {
        jsonRes(res, { success: false, error: '아이디 또는 비밀번호가 일치하지 않습니다' }, 401);
      }
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  // Admin token verify API
  if (pathname === '/api/admin/verify' && method === 'GET') {
    jsonRes(res, { valid: verifyAdminToken(req) });
    return true;
  }

  // Dashboard
  if (pathname === '/' || pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(getHtml('dashboard.html'));
    return true;
  }

  // Settings page
  if (pathname === '/settings') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(getHtml('settings.html'));
    return true;
  }

  // === Admin API 인증 체크 (클라이언트 API 제외) ===
  var isAdminApi = pathname.startsWith('/api/') && !pathname.startsWith('/api/admin/') && !pathname.startsWith('/api/client/');
  if (isAdminApi && !verifyAdminToken(req)) {
    jsonRes(res, { error: '인증이 필요합니다' }, 401);
    return true;
  }

  // API: Status
  if (pathname === '/api/status') {
    const wp = await checkConnection(env);
    const sb = await testSupabase();
    const publishedComboIds = await publishedTopics.getComboIds();
    const allTopics = await topicsDB.getAll();
    const topicCount = allTopics ? allTopics.length : 0;
    const total = topicCount * CONTENT_TYPES.length;
    const publishSettings = await settings.get('publish') || {};
    const totalTarget = publishSettings.totalTarget || total;

    // 발행 기간 내 콘텐츠 제작 건수 + WordPress 발행 건수
    let periodCreated = 0;
    let periodPublished = publishedComboIds.length;
    if (publishSettings.startDate) {
      const periodEnd = publishSettings.endDate || '2099-12-31';
      const periodQueue = await contentQueue.getByDateRange(publishSettings.startDate, periodEnd);
      periodCreated = (periodQueue || []).filter(function(item) {
        return item.status !== 'rejected' && !item.is_test;
      }).length;
      const periodLogs = await publishLogs.getByDateRange(publishSettings.startDate, periodEnd);
      periodPublished = (periodLogs || []).filter(function(item) {
        return (item.status === 'published' || item.status === 'success') && !item.is_test;
      }).length;
    }

    const nextTopic = await resolveNextTopic(allTopics);
    const nextPublishTime = await getNextPublishTime();

    // 발행 기간 정보 계산 (KST 기준)
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
      let totalDays = null, elapsedDays = null, pacePercent = null;
      if (startDate && endDate) {
        totalDays = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000*60*60*24)) + 1;
        if (todayStr >= startDate) {
          elapsedDays = Math.ceil((new Date(todayStr) - new Date(startDate)) / (1000*60*60*24)) + 1;
          if (elapsedDays > totalDays) elapsedDays = totalDays;
          pacePercent = totalDays > 0 ? Math.round((elapsedDays / totalDays) * 100) : 0;
        } else {
          elapsedDays = 0;
          pacePercent = 0;
        }
      }
      publishPeriod = { startDate: startDate, endDate: endDate, status: status, daysLeft: daysLeft, totalDays: totalDays, elapsedDays: elapsedDays, pacePercent: pacePercent };
    }

    jsonRes(res, {
      brand: BRAND.name,
      wordpress: wp,
      supabase: sb,
      nextPublishTime: nextPublishTime,
      publishPeriod: publishPeriod,
      ai: { model: 'gemini-2.5-flash-lite', status: env.GEMINI_API_KEY ? 'configured' : 'missing' },
      imageApis: {
        pixabay: { status: env.PIXABAY_API_KEY ? 'configured' : 'missing', priority: 1 },
        unsplash: { status: env.UNSPLASH_ACCESS_KEY ? 'configured' : 'missing', priority: 2 },
        pexels: { status: env.PEXELS_API_KEY ? 'configured' : 'missing', priority: 3 },
      },
      content: {
        totalTopics: topicCount,
        totalContentTypes: CONTENT_TYPES.length,
        totalCombinations: total,
        totalTarget: totalTarget,
        periodCreated: periodCreated,
        creationProgress: Math.round((periodCreated / totalTarget) * 100),
        published: periodPublished,
        publishedAll: publishedComboIds.length,
        remaining: totalTarget - periodPublished,
        uploadProgress: Math.round((periodPublished / totalTarget) * 100),
      },
      nextTopic: nextTopic,
      citationTracking: await (async function() {
        const citSettings = await settings.get('citation') || {};
        return {
        enabled: !!citationCronJob,
        settingEnabled: (citSettings.enabled !== false),
        frequency: citSettings.trackingFrequency || 'weekly',
        repeatCount: citSettings.repeatCount || 3,
        lastTrackTime: lastCitationTrackTime,
        nextTrackTime: (function() {
          try {
            // KST 기준으로 계산 (UTC+9)
            var nowMs = Date.now() + 9 * 60 * 60 * 1000;
            var kst = new Date(nowMs);
            var kstH = kst.getUTCHours();
            var kstDay = kst.getUTCDay();
            var kstDate = kst.getUTCDate();
            // 다음 실행 시각: KST 06:00 = UTC 21:00 (전날)
            var next = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 6, 0, 0));
            // next는 UTC 기준 KST날짜 06:00 → 실제 UTC로 변환하려면 -9시간
            var freq = ((citationCronJob || {})._freq) || 'daily';
            if (freq === 'daily') {
              if (kstH >= 6) next.setUTCDate(next.getUTCDate() + 1);
            } else if (freq === 'weekly') {
              // 매주 월요일 06:00 KST
              var daysUntilMon = (1 - kstDay + 7) % 7 || 7;
              if (kstDay === 1 && kstH < 6) daysUntilMon = 0;
              next.setUTCDate(kst.getUTCDate() + daysUntilMon);
            } else if (freq === 'biweekly') {
              if (kstDate < 1 || (kstDate === 1 && kstH < 6)) { next.setUTCDate(1); }
              else if (kstDate < 15 || (kstDate === 15 && kstH < 6)) { next.setUTCDate(15); }
              else { next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(1); }
            } else if (freq === 'monthly') {
              if (kstDate > 1 || (kstDate === 1 && kstH >= 6)) {
                next.setUTCMonth(next.getUTCMonth() + 1);
              }
              next.setUTCDate(1);
            } else {
              if (kstH >= 6) next.setUTCDate(next.getUTCDate() + 1);
            }
            // next는 KST 시각 → UTC로 변환 (-9시간)
            var utcNext = new Date(next.getTime() - 9 * 60 * 60 * 1000);
            return utcNext.toISOString();
          } catch(e) { return null; }
        })(),
        latestScores: await (async function() {
          try {
            const recent = await citationResults.getRecent(50);
            if (!recent || recent.length === 0) return null;
            var latestDate = recent[0].tracked_at;
            var latest = recent.filter(function(r) { return r.tracked_at === latestDate; });
            var modelAvg = {};
            for (var mi = 0; mi < latest.length; mi++) {
              var m = latest[mi].ai_model;
              if (!modelAvg[m]) modelAvg[m] = { sum: 0, count: 0 };
              modelAvg[m].sum += Number(latest[mi].score || 0);
              modelAvg[m].count++;
            }
            var result = {};
            Object.keys(modelAvg).forEach(function(k) {
              result[k] = Math.round(modelAvg[k].sum / modelAvg[k].count);
            });
            return { scores: result, date: latestDate, topicScores: latest.map(function(l) { return { topic: l.topic_name, model: l.ai_model, score: l.score }; }) };
          } catch(e) { return null; }
        })(),
      }; })(),
    });
    return true;
  }

  // API: Topics (DB 기반)
  if (pathname === '/api/topics' && method === 'GET') {
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');
    // 발행기간 파라미터가 있으면 해당 기간 내 발행된 combo_id만, 없으면 전체
    const publishedComboIds = (startDate || endDate)
      ? await contentQueue.getPublishedComboIdsByPeriod(startDate, endDate)
      : await publishedTopics.getComboIds();
    const includeInactive = url.searchParams.get('includeInactive') === '1';
    const allTopics = await topicsDB.getAll(includeInactive);
    const topicStatus = (allTopics || []).map(function(topic) {
      return {
        id: topic.id, name: topic.name, nameEn: topic.nameEn, slug: topic.slug, category: topic.category,
        keywords: topic.keywords || [], subtopics: topic.subtopics || [], medicalName: topic.medicalName, icd10: topic.icd10,
        pexelsQuery: topic.pexelsQuery, description: topic.description,
        is_active: topic.is_active, sort_order: topic.sort_order,
        contentStatus: CONTENT_TYPES.map(function(ct) {
          return {
            type: ct.name,
            comboId: topic.id + '__' + ct.id,
            published: publishedComboIds.includes(topic.id + '__' + ct.id),
          };
        }),
      };
    });
    jsonRes(res, topicStatus);
    return true;
  }

  // API: Topic CRUD
  if (pathname === '/api/topics' && method === 'POST') {
    try {
      const data = await parseBody(req);
      if (!data.slug) data.slug = data.id;
      if (!data.sort_order) {
        const all = await topicsDB.getAll(true);
        data.sort_order = (all ? all.length : 0) + 1;
      }
      const result = await topicsDB.add(data);
      jsonRes(res, { success: true, data: result });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  if (pathname.match(/^\/api\/topics\/[^/]+$/) && method === 'PUT') {
    const topicId = pathname.split('/')[3];
    try {
      const data = await parseBody(req);
      const result = await topicsDB.update(topicId, data);
      jsonRes(res, { success: true, data: result });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  if (pathname.match(/^\/api\/topics\/[^/]+$/) && method === 'DELETE') {
    const topicId = pathname.split('/')[3];
    try {
      await topicsDB.deactivate(topicId);
      jsonRes(res, { success: true });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  if (pathname === '/api/topics/reorder' && method === 'POST') {
    try {
      const { order } = await parseBody(req);
      await topicsDB.updateOrder(order);
      jsonRes(res, { success: true });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  // API: Recent Posts (with pagination)
  if (pathname === '/api/recent-posts') {
    const params = Object.fromEntries(url.searchParams);
    if (params.page) {
      const result = await publishLogs.search({
        page: parseInt(params.page) || 1,
        limit: parseInt(params.limit) || 10,
        search: params.search || '',
        status: params.status || '',
        sort: params.sort || 'latest',
      });
      jsonRes(res, result);
      return true;
    }
    const logs = await publishLogs.getRecent(100);
    jsonRes(res, logs || []);
    return true;
  }

  // API: Content Queue (with pagination)
  if (pathname === '/api/contents') {
    const params = Object.fromEntries(url.searchParams);
    const result = await contentQueue.search({
      page: parseInt(params.page) || 1,
      limit: parseInt(params.limit) || 10,
      search: params.search || '',
      status: params.status || '',
      topic: params.topic || '',
      sort: params.sort || 'latest',
    });
    const counts = await contentQueue.getCounts();
    jsonRes(res, { data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages, counts: counts });
    return true;
  }

  // API: Errors (GET: 조회, DELETE: 전체 삭제)
  if (pathname === '/api/errors' && method === 'GET') {
    const errorData = await settings.get('error_logs');
    jsonRes(res, errorData || []);
    return true;
  }
  if (pathname === '/api/error-logs' && method === 'DELETE') {
    await settings.set('error_logs', []);
    console.log('[Server] 에러 로그 전체 삭제');
    jsonRes(res, { success: true });
    return true;
  }

  // API: Publish Now - 1회 테스트 발행 (POST)
  if (pathname === '/api/publish-now' && method === 'POST') {
    if (getIsPublishing()) {
      jsonRes(res, { message: '이미 발행이 진행 중입니다. 완료 후 다시 시도해주세요.' }, 409);
      return true;
    }
    const allTopicsForPublish = await topicsDB.getAll();
    const next = await resolveNextTopic(allTopicsForPublish);

    autoPublish({ isTest: true }).catch(function(e) { saveErrorLog('테스트발행', e); });

    jsonRes(res, {
      message: '테스트 발행 시작됨 (기간/인덱스 영향 없음)',
      topic: next ? next.topic.name : '없음',
      contentType: next ? next.contentType.name : '없음',
    });
    return true;
  }

  // API: Scheduler Toggle (POST) - 스케줄 ON/OFF
  if (pathname === '/api/scheduler-toggle' && method === 'POST') {
    var toggleData = await parseBody(req).catch(function() { return {}; });
    if (typeof toggleData.enabled === 'boolean') {
      setSchedulerEnabled(toggleData.enabled);
      if (toggleData.enabled) {
        await setupCronSchedule();
        console.log('[Server] 스케줄 발행 활성화');
      } else {
        activeCronJobs.forEach(function(job) { job.stop(); });
        activeCronJobs.length = 0;
        console.log('[Server] 스케줄 발행 비활성화');
      }
    }
    jsonRes(res, { success: true, schedulerEnabled: getSchedulerEnabled() });
    return true;
  }

  // API: Scheduler Status (GET)
  if (pathname === '/api/scheduler-status' && method === 'GET') {
    jsonRes(res, { schedulerEnabled: getSchedulerEnabled(), activeJobs: activeCronJobs.length });
    return true;
  }

  // API: Get Settings
  if (pathname === '/api/settings' && method === 'GET') {
    const publishData = await settings.get('publish') || {};
    const defaultPublish = { publishFrequency: '5', publishDays: 'everyday', publishMode: 'auto', totalTarget: 50, nextTopic: 'auto', nextContentType: 'auto', imagesPerContent: 3 };
    var publishMerged = {};
    Object.keys(defaultPublish).forEach(function(k) { publishMerged[k] = defaultPublish[k]; });
    Object.keys(publishData).forEach(function(k) { publishMerged[k] = publishData[k]; });

    const allTopics = await topicsDB.getAll();
    const topicsList = (allTopics || []).map(function(t) {
      return { id: t.id, name: t.name, category: t.category, keywords: t.keywords || [] };
    });
    const ctList = CONTENT_TYPES.map(function(ct) { return { id: ct.id, name: ct.name }; });
    jsonRes(res, { publish: publishMerged, topics: topicsList, contentTypes: ctList });
    return true;
  }

  // API: Save Settings
  if (pathname === '/api/settings' && method === 'POST') {
    try {
      const data = await parseBody(req);
      if (data.publish) {
        await settings.set('publish', data.publish);
        await setupCronSchedule();
      }
      if (data.topics) await settings.set('topics', data.topics);
      jsonRes(res, { success: true });
    } catch (e) {
      jsonRes(res, { error: 'Invalid JSON' }, 400);
    }
    return true;
  }

  // Pexels 이미지 검색 API
  if (pathname === '/api/images' && method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const perPage = url.searchParams.get('per_page') || '3';
    const pexelsKey = process.env.PEXELS_API_KEY;
    if (!pexelsKey) {
      jsonRes(res, { error: 'PEXELS_API_KEY not set', images: [] });
      return true;
    }
    try {
      const pUrl = 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(query + ' asian korean') + '&per_page=' + (parseInt(perPage) * 3) + '&page=' + (Math.floor(Math.random() * 5) + 1) + '&orientation=landscape';
      const pResp = await fetch(pUrl, { headers: { Authorization: pexelsKey } });
      const pData = await pResp.json();
      const images = (pData.photos || []).map(function(p) {
        return { id: p.id, url: p.src.medium, alt: p.alt || query, photographer: p.photographer, pexelsUrl: p.url };
      });
      jsonRes(res, { images: images, total: pData.total_results || 0 });
    } catch (e) {
      jsonRes(res, { error: e.message, images: [] });
    }
    return true;
  }

  // API: Content Preview
  if (pathname === '/api/content-preview' && method === 'GET') {
    const qId = url.searchParams.get('id');
    const qTitle = url.searchParams.get('title');
    let item = null;
    try {
      if (qId) {
        item = await contentQueue.getById(qId);
      } else if (qTitle) {
        item = await contentQueue.getByTitle(decodeURIComponent(qTitle));
      }
    } catch (e) { item = null; }
    if (!item) {
      jsonRes(res, { error: 'Content not found' }, 404);
      return true;
    }
    jsonRes(res, {
      title: item.title,
      content: item.content,
      topic: item.topic_name,
      contentType: item.content_type_name,
      status: item.status,
      createdAt: item.created_at,
      original_title: item.original_title || null,
      original_content: item.original_content || null,
    });
    return true;
  }

  // --- 기존 발행글 스키마 메타 일괄 재전송 (깨진 _hwj_jsonld 복구) ---
  if (pathname === '/api/fix-schema-meta' && method === 'POST') {
    if (!verifyAdminToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    try {
      const all = await contentQueue.getAll();
      const published = (all || []).filter(function(it) { return it.wp_post_id && it.schemas; });
      let ok = 0, fail = 0;
      const results = [];
      for (const it of published) {
        try {
          await updatePostMetaViaBridge(env, it.wp_post_id, {
            _hwj_jsonld: JSON.stringify(it.schemas),
          });
          ok++;
          results.push({ wp_post_id: it.wp_post_id, status: 'ok' });
        } catch (e) {
          fail++;
          results.push({ wp_post_id: it.wp_post_id, status: 'fail', error: e.message });
        }
      }
      jsonRes(res, { success: true, total: published.length, ok: ok, fail: fail, results: results });
    } catch (e) {
      await saveErrorLog('스키마메타재전송', e);
      jsonRes(res, { error: e.message }, 500);
    }
    return true;
  }

  // --- 기존 발행글 본문 일괄 재전송 (DB 정정 내용을 WP 라이브에 반영) ---
  if (pathname === '/api/resync-content' && method === 'POST') {
    if (!verifyAdminToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return true; }
    try {
      const all = await contentQueue.getAll();
      const published = (all || []).filter(function(it) { return it.wp_post_id && it.content; });
      let ok = 0, fail = 0;
      const results = [];
      for (const it of published) {
        try {
          await updateWordPressPost(env, it.wp_post_id, { content: it.content });
          ok++;
          results.push({ wp_post_id: it.wp_post_id, status: 'ok' });
        } catch (e) {
          fail++;
          results.push({ wp_post_id: it.wp_post_id, status: 'fail', error: e.message });
        }
      }
      jsonRes(res, { success: true, total: published.length, ok: ok, fail: fail, results: results });
    } catch (e) {
      await saveErrorLog('본문재전송', e);
      jsonRes(res, { error: e.message }, 500);
    }
    return true;
  }

  // --- 품질 점수 재계산 API ---
  if (pathname === '/api/recalculate-scores' && method === 'POST') {
    try {
      const all = await contentQueue.getAll();
      let updated = 0;
      for (const item of (all || [])) {
        if (!item.content) continue;
        const geo = calculateGeoScore(item.content, item.title || '', item.meta_description || '', item.faq || [], item.schemas || {});
        const eeat = calculateEeatScore(item.content, item.title || '');
        await contentQueue.updateStatus(item.id, item.status, {
          geo_score: geo.score,
          eeat_score: eeat.score,
        });
        updated++;
      }
      jsonRes(res, { success: true, updated: updated, message: updated + '건 점수 재계산 완료' });
    } catch (e) {
      console.error('[Recalculate] 에러:', e.message);
      jsonRes(res, { error: e.message }, 500);
    }
    return true;
  }

  // --- 품질 점수 API ---
  if (pathname === '/api/quality-scores' && method === 'GET') {
    try {
      const all = await contentQueue.getAll();
      const scored = (all || []).map(function(item) {
        return {
          id: item.id,
          title: item.title,
          topic_name: item.topic_name,
          content_type_name: item.content_type_name,
          status: item.status,
          geo_score: item.geo_score || 0,
          eeat_score: item.eeat_score || 0,
          geo_details: item.geo_details || {},
          eeat_details: item.eeat_details || {},
          created_at: item.created_at,
        };
      });
      jsonRes(res, scored);
    } catch (e) {
      console.error('[Quality Scores] 에러:', e.message);
      jsonRes(res, { error: e.message }, 500);
    }
    return true;
  }

  // --- Admin API: Delete (관리자 대시보드용) ---
  if (pathname.match(/^\/api\/contents\/[^/]+$/) && method === 'DELETE') {
    const itemId = pathname.split('/')[3];
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

  // === 이미지 API 설정 ===

  if (pathname === '/api/image-settings' && method === 'GET') {
    const imgSettings = await settings.get('imageApis') || {};
    jsonRes(res, {
      pixabayApiKey: imgSettings.pixabayApiKey || '',
      unsplashAccessKey: imgSettings.unsplashAccessKey || '',
      pexelsApiKey: imgSettings.pexelsApiKey || '',
    });
    return true;
  }

  if (pathname === '/api/image-settings' && method === 'POST') {
    try {
      const data = await parseBody(req);
      await settings.set('imageApis', data);
      // 환경변수에도 반영 (런타임)
      if (data.pixabayApiKey) env.PIXABAY_API_KEY = data.pixabayApiKey;
      if (data.unsplashAccessKey) env.UNSPLASH_ACCESS_KEY = data.unsplashAccessKey;
      if (data.pexelsApiKey) env.PEXELS_API_KEY = data.pexelsApiKey;
      jsonRes(res, { success: true });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  // 이 라우트에 매칭되지 않음
  return false;
}
