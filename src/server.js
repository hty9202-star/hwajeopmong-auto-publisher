/**
 * 화접몹 GEO Auto-Publisher 서버 (Node.js + Supabase)
 * Supabase PostgreSQL로 데이터 관리
 *
 * 실행: node src/server.js
 * 환경변수: Render 대시보드 또는 .env에서 설정
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { CONTENT_TYPES, BRAND } from './config.js';
import { generateContent } from './content-generator.js';
import { publishToWordPress, getRecentPosts, checkConnection } from './wordpress-publisher.js';
import { contentQueue, publishLogs, publishedTopics, settings, topics as topicsDB, testConnection as testSupabase } from './supabase-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// env 객체 (WordPress, Gemini 등 외부 API용)
const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinictest.wordpress.com',
  WP_ACCESS_TOKEN: process.env.WP_ACCESS_TOKEN,
  PEXELS_API_KEY: process.env.PEXELS_API_KEY,
};

// ─── DB에서 토픽 로테이션 ───
async function getNextTopicFromDB(publishedComboIds = []) {
  const allTopics = await topicsDB.getAll();
  if (!allTopics || allTopics.length === 0) return null;

  const allCombinations = [];
  for (const topic of allTopics) {
    for (const type of [...CONTENT_TYPES].sort((a, b) => a.priority - b.priority)) {
      const comboId = `${topic.id}__${type.id}`;
      if (!publishedComboIds.includes(comboId)) {
        allCombinations.push({ topic, contentType: type, comboId });
      }
    }
  }

  if (allCombinations.length === 0) {
    return {
      topic: allTopics[0],
      contentType: CONTENT_TYPES[0],
      comboId: `${allTopics[0].id}__${CONTENT_TYPES[0].id}`,
      isRepublish: true,
    };
  }
  return { ...allCombinations[0], isRepublish: false };
}

// ─── 자동 발행 로직 ───
async function autoPublish() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { console.log('No GEMINI_API_KEY'); return; }

    // DB에서 활성 토픽 로드
    const allTopics = await topicsDB.getAll();
    if (!allTopics || allTopics.length === 0) { console.log('No active topics'); return; }

    // 설정 로드
    const savedSettings = await settings.get('publish') || {};
    const publish = savedSettings;

    // 토픽 인덱스
    const idxData = await settings.get('topicIndex');
    let topicIdx = idxData ? parseInt(idxData) : 0;

    let topic;
    if (publish.nextTopic && publish.nextTopic !== 'auto') {
      topic = allTopics.find(t => t.id === publish.nextTopic) || allTopics[topicIdx % allTopics.length];
    } else {
      topic = allTopics[topicIdx % allTopics.length];
    }

    const ctIdxData = await settings.get('contentTypeIndex');
    let ctIdx = ctIdxData ? parseInt(ctIdxData) : 0;
    const contentType = CONTENT_TYPES[ctIdx % CONTENT_TYPES.length];

    console.log('Generating: ' + topic.name + ' / ' + contentType.name);
    const result = await generateContent(process.env, topic, contentType);

    if (result && result.content) {
      const comboId = `${topic.id}__${contentType.id}`;

      // Supabase에 콘텐츠 추가
      const inserted = await contentQueue.add({
        combo_id: comboId,
        topic_id: topic.id,
        topic_name: topic.name,
        content_type_id: contentType.id,
        content_type_name: contentType.name,
        title: result.title,
        slug: result.slug,
        content: result.content,
        excerpt: result.excerpt,
        meta_description: result.metaDescription,
        category: result.category || topic.name,
        tags: result.tags || [],
        hero_image_url: result.heroImage?.url || null,
        schemas: result.schemas || null,
        faq: result.faq || null,
        status: 'pending',
      });

      const queueId = inserted?.[0]?.id || null;
      console.log('Queued: ' + result.title + ' (ID: ' + queueId + ')');

      // 발행 로그 추가
      await publishLogs.add({
        queue_id: queueId,
        combo_id: comboId,
        topic_name: topic.name,
        content_type_name: contentType.name,
        title: result.title,
        status: 'queued',
        created_at: new Date().toISOString(),
      });

      // 인덱스 업데이트
      topicIdx = (topicIdx + 1) % allTopics.length;
      ctIdx = (ctIdx + 1) % CONTENT_TYPES.length;
      await settings.set('topicIndex', topicIdx);
      await settings.set('contentTypeIndex', ctIdx);

      // nextTopic 리셋
      if (publish.nextTopic && publish.nextTopic !== 'auto') {
        publish.nextTopic = 'auto';
        await settings.set('publish', publish);
      }
    }
  } catch (e) { console.error('autoPublish error:', e); }
}

// ─── 발행 주기 프리셋 ───
const FREQUENCY_PRESETS = {
  '1': ['0 9 * * *'],
  '2': ['0 9 * * *', '0 15 * * *'],
  '3': ['0 9 * * *', '0 13 * * *', '0 17 * * *'],
  '5': ['0 9 * * *', '0 11 * * *', '0 13 * * *', '0 15 * * *', '0 17 * * *'],
};
const FREQUENCY_LABELS = {
  '1': '09:00 (1회/일)',
  '2': '09:00, 15:00 (2회/일)',
  '3': '09:00, 13:00, 17:00 (3회/일)',
  '5': '09:00, 11:00, 13:00, 15:00, 17:00 (5회/일)',
};

let activeCronJobs = [];

async function setupCronSchedule() {
  // 기존 cron 중지
  activeCronJobs.forEach(job => job.stop());
  activeCronJobs = [];

  const publishSettings = await settings.get('publish') || {};
  const frequency = publishSettings.publishFrequency || '5';
  const days = publishSettings.publishDays || 'everyday';

  const crons = FREQUENCY_PRESETS[frequency] || FREQUENCY_PRESETS['5'];

  crons.forEach(cronExpr => {
    // 평일만이면 cron 요일 부분을 1-5로 변경
    const finalExpr = days === 'weekdays' ? cronExpr.replace(/\*$/, '1-5') : cronExpr;
    const job = cron.schedule(finalExpr, autoPublish, { timezone: 'Asia/Seoul' });
    activeCronJobs.push(job);
  });

  const daysLabel = days === 'weekdays' ? '평일만' : '매일';
  console.log(`[Server] Cron 스케줄 등록: ${daysLabel} ${FREQUENCY_LABELS[frequency] || FREQUENCY_LABELS['5']}`);
}

setupCronSchedule();

// ─── HTTP 서버 ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  try {
    // Dashboard
    if (pathname === '/' || pathname === '/dashboard') {
      const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // Settings page
    if (pathname === '/settings') {
      const html = fs.readFileSync(`${__dirname}/settings.html`, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
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

      // nextTopic 계산
      let nextTopic = null;
      if (publishSettings.nextTopic && publishSettings.nextTopic !== 'auto') {
        const selectedTopic = allTopics ? allTopics.find(t => t.id === publishSettings.nextTopic) : null;
        if (selectedTopic) {
          nextTopic = { topic: selectedTopic, contentType: CONTENT_TYPES[0], comboId: selectedTopic.id + '__' + CONTENT_TYPES[0].id };
        }
      }
      if (!nextTopic) {
        nextTopic = await getNextTopicFromDB(publishedComboIds);
      }

      return jsonRes(res, {
        brand: BRAND.name,
        wordpress: wp,
        supabase: sb,
        ai: { model: 'gemini-2.5-flash-lite', status: env.GEMINI_API_KEY ? 'configured' : 'missing' },
        pexels: { status: env.PEXELS_API_KEY ? 'configured' : 'missing' },
        content: {
          totalTopics: topicCount,
          totalContentTypes: CONTENT_TYPES.length,
          totalCombinations: total,
          totalTarget: totalTarget,
          published: publishedComboIds.length,
          remaining: totalTarget - publishedComboIds.length,
          progress: `${Math.round((publishedComboIds.length / totalTarget) * 100)}%`,
        },
        nextTopic,
      });
    }

    // API: Topics (DB 기반)
    if (pathname === '/api/topics' && method === 'GET') {
      const publishedComboIds = await publishedTopics.getComboIds();
      const allTopics = await topicsDB.getAll();
      const topicStatus = (allTopics || []).map((topic) => ({
        ...topic,
        keywords: topic.keywords || [],
        contentStatus: CONTENT_TYPES.map((ct) => ({
          type: ct.name,
          comboId: `${topic.id}__${ct.id}`,
          published: publishedComboIds.includes(`${topic.id}__${ct.id}`),
        })),
      }));
      return jsonRes(res, topicStatus);
    }

    // API: Topic CRUD
    if (pathname === '/api/topics' && method === 'POST') {
      let body = '';
      req.on('data', ch => body += ch);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          // slug 자동 생성 (없으면)
          if (!data.slug) data.slug = data.id;
          // sort_order 자동 설정
          if (!data.sort_order) {
            const all = await topicsDB.getAll(true);
            data.sort_order = (all ? all.length : 0) + 1;
          }
          const result = await topicsDB.add(data);
          jsonRes(res, { success: true, data: result });
        } catch (e) { jsonRes(res, { error: e.message }, 400); }
      });
      return;
    }

    if (pathname.match(/^\/api\/topics\/[^/]+$/) && method === 'PUT') {
      const topicId = pathname.split('/')[3];
      let body = '';
      req.on('data', ch => body += ch);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const result = await topicsDB.update(topicId, data);
          jsonRes(res, { success: true, data: result });
        } catch (e) { jsonRes(res, { error: e.message }, 400); }
      });
      return;
    }

    if (pathname.match(/^\/api\/topics\/[^/]+$/) && method === 'DELETE') {
      const topicId = pathname.split('/')[3];
      try {
        await topicsDB.deactivate(topicId);
        jsonRes(res, { success: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
      return;
    }

    if (pathname === '/api/topics/reorder' && method === 'POST') {
      let body = '';
      req.on('data', ch => body += ch);
      req.on('end', async () => {
        try {
          const { order } = JSON.parse(body);
          await topicsDB.updateOrder(order);
          jsonRes(res, { success: true });
        } catch (e) { jsonRes(res, { error: e.message }, 400); }
      });
      return;
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
        return jsonRes(res, result);
      }
      const logs = await publishLogs.getRecent(100);
      return jsonRes(res, logs || []);
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
      return jsonRes(res, { ...result, counts });
    }

    // API: Errors
    if (pathname === '/api/errors') {
      const errorData = await settings.get('error_logs');
      return jsonRes(res, errorData || []);
    }

    // API: Publish Now (POST)
    if (pathname === '/api/publish-now' && method === 'POST') {
      const publishedComboIds = await publishedTopics.getComboIds();
      const next = await getNextTopicFromDB(publishedComboIds);

      autoPublish().catch(console.error);

      return jsonRes(res, {
        message: '발행 시작됨',
        topic: next ? next.topic.name : '없음',
        contentType: next ? next.contentType.name : '없음',
      });
    }

    // API: Get Settings
    if (pathname === '/api/settings' && method === 'GET') {
      const publishData = await settings.get('publish') || {};
      const defaultPublish = { publishFrequency: '5', publishDays: 'everyday', totalTarget: 50, nextTopic: 'auto', imagesPerContent: 3 };
      const publish = { ...defaultPublish, ...publishData };

      const allTopics = await topicsDB.getAll();
      const topicsList = (allTopics || []).map(t => ({
        id: t.id, name: t.name, category: t.category,
        keywords: t.keywords || [],
      }));
      return jsonRes(res, { publish, topics: topicsList });
    }

    // API: Save Settings
    if (pathname === '/api/settings' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (data.publish) {
            await settings.set('publish', data.publish);
            // 발행 주기가 변경되면 cron 재설정
            await setupCronSchedule();
          }
          if (data.topics) await settings.set('topics', data.topics);
          return jsonRes(res, { success: true });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // Pexels 이미지 검색 API
    if (pathname === '/api/images' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const perPage = url.searchParams.get('per_page') || '3';
      const pexelsKey = process.env.PEXELS_API_KEY;
      if (!pexelsKey) {
        return jsonRes(res, { error: 'PEXELS_API_KEY not set', images: [] });
      }
      try {
        const pUrl = 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(query + ' asian korean') + '&per_page=' + (parseInt(perPage) * 3) + '&page=' + (Math.floor(Math.random() * 5) + 1) + '&orientation=landscape';
        const pResp = await fetch(pUrl, { headers: { Authorization: pexelsKey } });
        const pData = await pResp.json();
        const images = (pData.photos || []).map(p => ({
          id: p.id,
          url: p.src.medium,
          alt: p.alt || query,
          photographer: p.photographer,
          pexelsUrl: p.url,
        }));
        return jsonRes(res, { images, total: pData.total_results || 0 });
      } catch (e) {
        return jsonRes(res, { error: e.message, images: [] });
      }
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
      } catch { item = null; }
      if (!item) {
        return jsonRes(res, { error: 'Content not found' }, 404);
      }
      return jsonRes(res, {
        title: item.title,
        content: item.content,
        topic: item.topic_name,
        contentType: item.content_type_name,
        status: item.status,
        createdAt: item.created_at,
      });
    }

    // --- Client Login Page ---
    if (pathname === '/client/login' && method === 'GET') {
      const html = fs.readFileSync(__dirname + '/client-login.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname === '/client' && method === 'GET') {
      const html = fs.readFileSync(__dirname + '/client-dashboard.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // --- Client API: Login ---
    if (pathname === '/api/client/login' && method === 'POST') {
      let body = '';
      req.on('data', ch => body += ch);
      req.on('end', () => {
        try {
          const { id, password } = JSON.parse(body);
          const cid = process.env.CLIENT_ID || 'hwajeopmong';
          const cpw = process.env.CLIENT_PASSWORD || 'hwj2024!';
          if (id === cid && password === cpw) {
            const tk = genToken();
            CLIENT_TOKENS.set(tk, { id, at: new Date().toISOString() });
            jsonRes(res, { success: true, token: tk });
          } else {
            jsonRes(res, { success: false, error: 'Invalid credentials' }, 401);
          }
        } catch (e) { jsonRes(res, { error: e.message }, 400); }
      });
      return;
    }

    // --- Client API: Contents List (with pagination) ---
    if (pathname === '/api/client/contents' && method === 'GET') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const params = Object.fromEntries(url.searchParams);
      const result = await contentQueue.search({
        page: parseInt(params.page) || 1,
        limit: parseInt(params.limit) || 10,
        search: params.search || '',
        status: params.status || '',
        sort: params.sort || 'latest',
      });
      const counts = await contentQueue.getCounts();
      jsonRes(res, { ...result, counts });
      return;
    }

    // --- Client API: Approve ---
    if (pathname.match(/^\/api\/client\/contents\/[^/]+\/approve$/) && method === 'POST') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = pathname.split('/')[4];
      const item = await contentQueue.getById(itemId);
      if (!item || item.status !== 'pending') { jsonRes(res, { error: 'Not found' }, 404); return; }

      try {
        const wpR = await publishToWordPress(env, {
          title: item.title,
          content: item.content,
          heroImage: item.hero_image_url ? { url: item.hero_image_url } : null,
          category: item.category,
          tags: item.tags,
        }, 'publish');

        // 큐 상태 업데이트
        await contentQueue.updateStatus(itemId, 'approved', {
          wp_post_id: wpR.id,
          wp_post_url: wpR.link,
        });

        // published_topics 업데이트
        await publishedTopics.add(item.combo_id, item.topic_id, item.content_type_id);

        // 발행 로그 업데이트
        await publishLogs.updateByQueueId(itemId, {
          status: 'published',
          wp_post_id: wpR.id,
          wp_post_url: wpR.link,
          published_at: new Date().toISOString(),
        });

        jsonRes(res, { success: true, wpLink: wpR.link });
      } catch (e) { jsonRes(res, { error: e.message }, 500); }
      return;
    }

    // --- Client API: Reject ---
    if (pathname.match(/^\/api\/client\/contents\/[^/]+\/reject$/) && method === 'POST') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = pathname.split('/')[4];
      const item = await contentQueue.getById(itemId);
      if (!item || item.status !== 'pending') { jsonRes(res, { error: 'Not found' }, 404); return; }

      await contentQueue.updateStatus(itemId, 'rejected');

      // 발행 로그 업데이트
      await publishLogs.updateByQueueId(itemId, {
        status: 'rejected',
      });

      jsonRes(res, { success: true });

      // 새 콘텐츠 자동 생성
      autoPublish().catch(e => console.error('Regen error:', e));
      return;
    }

    // --- Client/Admin API: Delete (반려된 콘텐츠만) ---
    if (pathname.match(/^\/api\/client\/contents\/[^/]+$/) && method === 'DELETE') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = pathname.split('/')[4];
      const item = await contentQueue.getById(itemId);
      if (!item) { jsonRes(res, { error: 'Not found' }, 404); return; }
      if (item.status !== 'rejected') {
        jsonRes(res, { error: '반려된 콘텐츠만 삭제할 수 있습니다' }, 400);
        return;
      }
      await contentQueue.delete(itemId);
      jsonRes(res, { success: true });
      return;
    }

    // --- Admin API: Delete (관리자 대시보드용) ---
    if (pathname.match(/^\/api\/contents\/[^/]+$/) && method === 'DELETE') {
      const itemId = pathname.split('/')[3];
      const item = await contentQueue.getById(itemId);
      if (!item) { jsonRes(res, { error: 'Not found' }, 404); return; }
      if (item.status !== 'rejected') {
        jsonRes(res, { error: '반려된 콘텐츠만 삭제할 수 있습니다' }, 400);
        return;
      }
      await contentQueue.delete(itemId);
      jsonRes(res, { success: true });
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    console.error('Server error:', error);
    jsonRes(res, { error: error.message }, 500);
  }
});

// === Client Auth ===
const CLIENT_TOKENS = new Map();
function genToken() {
  let t = ''; const ch = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += ch[Math.floor(Math.random() * ch.length)];
  return t;
}
function verifyToken(req) {
  const a = req.headers['authorization'];
  if (!a) return false;
  return CLIENT_TOKENS.has(a.replace('Bearer ', ''));
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

server.listen(PORT, () => {
  console.log(`\n[Server] 화접몽 GEO Auto-Publisher 실행 중 (Supabase DB)`);
  console.log(`[Server] 대시보드: http://localhost:${PORT}/dashboard`);
  console.log(`[Server] 광고주: http://localhost:${PORT}/client`);
  console.log(`[Server] API: http://localhost:${PORT}/api/status\n`);
});
