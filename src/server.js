/**
 * Railway/로컬 실행용 서버 (Node.js)
 * Cloudflare Workers와 동일한 로직을 node-cron으로 실행
 *
 * 실행: node src/server.js
 * 환경변수: .env 파일 또는 Railway 대시보드에서 설정
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron'
import { TOPICS, CONTENT_TYPES, BRAND, getNextTopic } from './config.js';
import { generateContent } from './content-generator.js';
import { publishToWordPress, getRecentPosts, checkConnection } from './wordpress-publisher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── 간단한 KV 대체 (파일 기반) ───
const KV_PATH = path.join(__dirname, '../data');
if (!fs.existsSync(KV_PATH)) fs.mkdirSync(KV_PATH, { recursive: true });

const kvStore = {
  async get(key) {
    try {
      return fs.readFileSync(path.join(KV_PATH, `${key}.json`), 'utf-8');
    } catch { return null; }
  },
  async put(key, value) {
    fs.writeFileSync(path.join(KV_PATH, `${key}.json`), value);
  },
};

// env 객체 시뮬레이션
const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinictest.wordpress.com',
  WP_ACCESS_TOKEN: process.env.WP_ACCESS_TOKEN,
  PEXELS_API_KEY: process.env.PEXELS_API_KEY,
  HWJ_KV: kvStore,
};

// ─── 자동 발행 로직 ───
async function autoPublish() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { console.log('No GEMINI_API_KEY'); return; }
    const savedRaw = await kvStore.get('settings');
    const saved = savedRaw ? JSON.parse(savedRaw) : {};
    const publish = saved.publish || {};
    const idxRaw = await kvStore.get('topicIndex');
    let topicIdx = idxRaw ? parseInt(idxRaw) : 0;
    let topic;
    if (publish.nextTopic && publish.nextTopic !== 'auto') {
      topic = TOPICS.find(t => t.id === publish.nextTopic) || TOPICS[topicIdx % TOPICS.length];
    } else {
      topic = TOPICS[topicIdx % TOPICS.length];
    }
    const ctIdxRaw = await kvStore.get('contentTypeIndex');
    let ctIdx = ctIdxRaw ? parseInt(ctIdxRaw) : 0;
    const contentType = CONTENT_TYPES[ctIdx % CONTENT_TYPES.length];
    console.log('Generating: ' + topic.name + ' / ' + contentType.name);
    const result = await generateContent(process.env, topic, contentType);
    if (result && result.content) {
      const qRaw = await kvStore.get('contentQueue');
      const queue = qRaw ? JSON.parse(qRaw) : [];
      queue.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2,5),
        title: result.title, content: result.content,
        topic: topic.name, topicId: topic.id, contentType: contentType.name,
        status: 'pending', createdAt: new Date().toISOString(),
        heroImage: result.heroImage || null, images: result.images || [],
        category: result.category || topic.name, tags: result.tags || [],
      });
      await kvStore.put('contentQueue', JSON.stringify(queue));
      console.log('Queued: ' + result.title);

      // 대시보드용 발행 로그 업데이트
      const comboId = `${topic.id}__${contentType.id}`;
      const queueId = queue[queue.length - 1].id;  // 방금 push한 아이템의 ID
      const logsRaw = await kvStore.get('publish_logs');
      const logs = logsRaw ? JSON.parse(logsRaw) : [];
      logs.unshift({
        comboId,
        queueId,
        topicName: topic.name,
        contentType: contentType.name,
        title: result.title,
        status: 'queued',
        createdAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
      });
      await kvStore.put('publish_logs', JSON.stringify(logs.slice(0, 100)));

      topicIdx = (topicIdx + 1) % TOPICS.length;
      ctIdx = (ctIdx + 1) % CONTENT_TYPES.length;
      await kvStore.put('topicIndex', String(topicIdx));
      await kvStore.put('contentTypeIndex', String(ctIdx));
      if (publish.nextTopic && publish.nextTopic !== 'auto') {
        publish.nextTopic = 'auto'; saved.publish = publish;
        await kvStore.put('settings', JSON.stringify(saved));
      }
    }
  } catch (e) { console.error('autoPublish error:', e); }
}

// ─── Cron 스케줄 (09:00, 11:00, 13:00, 15:00, 17:00 KST) ───
cron.schedule('0 9 * * *', autoPublish, { timezone: 'Asia/Seoul' });
cron.schedule('0 11 * * *', autoPublish, { timezone: 'Asia/Seoul' });
cron.schedule('0 13 * * *', autoPublish, { timezone: 'Asia/Seoul' });
cron.schedule('0 15 * * *', autoPublish, { timezone: 'Asia/Seoul' });
cron.schedule('0 17 * * *', autoPublish, { timezone: 'Asia/Seoul' });
console.log('[Server] Cron 스케줄 등록: 매일 09:00, 11:00, 13:00, 15:00, 17:00 KST (5건/일)');

// ─── HTTP 서버 ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
    const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  try {
    // Dashboard
    if (path === '/' || path === '/dashboard') {
      const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }



    // Settings page
    if (path === '/settings') {
      const html = fs.readFileSync(`${__dirname}/settings.html`, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // API: Status
    if (path === '/api/status') {
      const wp = await checkConnection(env);
      const publishedRaw = await kvStore.get('published_topics');
      const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
      const total = TOPICS.length * CONTENT_TYPES.length;
    const settingsRaw = await kvStore.get('settings');
    const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
    const totalTarget = settings?.publish?.totalTarget || total;

      return jsonRes(res, {
        brand: BRAND.name,
        wordpress: wp,
        ai: { model: 'gemini-2.5-flash-lite', status: env.GEMINI_API_KEY ? 'configured' : 'missing' },
        pexels: { status: env.PEXELS_API_KEY ? 'configured' : 'missing' },
        content: {
          totalTopics: TOPICS.length,
          totalContentTypes: CONTENT_TYPES.length,
          totalCombinations: total,
          totalTarget: totalTarget,
          published: publishedTopicIds.length,
          remaining: totalTarget - publishedTopicIds.length,
          progress: `${Math.round((publishedTopicIds.length / totalTarget) * 100)}%`,
        },
        nextTopic: getNextTopic(publishedTopicIds),
      });
    }

    // API: Topics
    if (path === '/api/topics') {
      const publishedRaw = await kvStore.get('published_topics');
      const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
      const topicStatus = TOPICS.map((topic) => ({
        ...topic,
        contentStatus: CONTENT_TYPES.map((ct) => ({
          type: ct.name,
          comboId: `${topic.id}__${ct.id}`,
          published: publishedTopicIds.includes(`${topic.id}__${ct.id}`),
        })),
      }));
      return jsonRes(res, topicStatus);
    }

    // API: Recent Posts
    if (path === '/api/recent-posts') {
      const logsRaw = await kvStore.get('publish_logs');
      return jsonRes(res, logsRaw ? JSON.parse(logsRaw) : []);
    }

    // API: Errors
    if (path === '/api/errors') {
      const errorsRaw = await kvStore.get('error_logs');
      return jsonRes(res, errorsRaw ? JSON.parse(errorsRaw) : []);
    }

    // API: Publish Now (POST)
    if (path === '/api/publish-now' && req.method === 'POST') {
      const publishedRaw = await kvStore.get('published_topics');
      const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
      const next = getNextTopic(publishedTopicIds);

      // 비동기 발행
      autoPublish().catch(console.error);

      return jsonRes(res, {
        message: '발행 시작됨',
        topic: next.topic.name,
        contentType: next.contentType.name,
      });
    }

    // API: Get Settings
    if (path === '/api/settings' && req.method === 'GET') {
      const savedRaw = await kvStore.get('settings');
      const saved = savedRaw ? JSON.parse(savedRaw) : {};
      const defaultPublish = { postsPerDay: 5, postsPerSlot: 1, defaultStatus: 'draft', totalTarget: 50, nextTopic: 'auto', imagesPerContent: 3 };
      const publish = { ...defaultPublish, ...(saved.publish || {}) };
      const topics = TOPICS.map(t => {
        const savedTopic = saved.topics ? saved.topics.find(st => st.id === t.id) : null;
        return {
          id: t.id, name: t.name, category: t.category,
          keywords: savedTopic ? savedTopic.keywords : [...t.keywords]
        };
      });
      return jsonRes(res, { publish, topics });
    }

    // API: Save Settings
    if (path === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const settings = JSON.parse(body);
          kvStore.put('settings', JSON.stringify(settings));
          return jsonRes(res, { success: true });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }


    // Pexels 이미지 검색 API
    if (path === '/api/images' && req.method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const perPage = url.searchParams.get('per_page') || '3';
      const pexelsKey = process.env.PEXELS_API_KEY;
      if (!pexelsKey) {
        return jsonRes(res, { error: 'PEXELS_API_KEY not set', images: [] });
      }
      try {
        const pUrl = 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(query + ' asian korean') + '&per_page=' + (parseInt(perPage)*3) + '&page=' + (Math.floor(Math.random()*5)+1) + '&orientation=landscape';
        const pResp = await fetch(pUrl, { headers: { Authorization: pexelsKey } });
        const pData = await pResp.json();
        const images = (pData.photos || []).map(p => ({
          id: p.id,
          url: p.src.medium,
          alt: p.alt || query,
          photographer: p.photographer,
          pexelsUrl: p.url
        }));
        return jsonRes(res, { images, total: pData.total_results || 0 });
      } catch (e) {
        return jsonRes(res, { error: e.message, images: [] });
      }
    }


    // API: Content Preview (대시보드에서 대기중 콘텐츠 미리보기)
    if (path === '/api/content-preview' && method === 'GET') {
      const queue = await getQueue();
      const qId = url.searchParams.get('id');
      const qTitle = url.searchParams.get('title');
      let item = null;
      if (qId) {
        item = queue.find(i => i.id === qId);
      } else if (qTitle) {
        const decoded = decodeURIComponent(qTitle);
        item = queue.find(i => i.title === decoded);
      }
      if (!item) {
        return jsonRes(res, { error: 'Content not found' }, 404);
      }
      return jsonRes(res, { title: item.title, content: item.content, topic: item.topic, contentType: item.contentType, status: item.status, createdAt: item.createdAt });
    }

    // --- Client Login Page ---
    if (path === '/client/login' && method === 'GET') {
            const html = fs.readFileSync(__dirname + '/client-login.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (path === '/client' && method === 'GET') {
            const html = fs.readFileSync(__dirname + '/client-dashboard.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    // --- Client API ---
    if (path === '/api/client/login' && method === 'POST') {
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
        } catch(e) { jsonRes(res, { error: e.message }, 400); }
      });
      return;
    }
    if (path === '/api/client/contents' && method === 'GET') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const queue = await getQueue();
      const sorted = queue.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
      jsonRes(res, { contents: sorted, stats: {
        pending: queue.filter(i => i.status==='pending').length,
        approved: queue.filter(i => i.status==='approved').length,
        rejected: queue.filter(i => i.status==='rejected').length,
      }});
      return;
    }
    if (path.match(/^\/api\/client\/contents\/[^/]+\/approve$/) && method === 'POST') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = path.split('/')[4];
      const queue = await getQueue();
      const item = queue.find(i => i.id === itemId && i.status === 'pending');
      if (!item) { jsonRes(res, { error: 'Not found' }, 404); return; }
      try {
        const wpR = await publishToWordPress(env, { title: item.title, content: item.content, heroImage: item.heroImage, images: item.images, category: item.category, tags: item.tags }, 'publish');
        item.status = 'approved'; item.approvedAt = new Date().toISOString(); item.wpLink = wpR.link || '';
        await saveQueue(queue);

        // 대시보드 진행률 업데이트
        const pubRaw = await kvStore.get('published_topics');
        const pubIds = pubRaw ? JSON.parse(pubRaw) : [];
        const cType = CONTENT_TYPES.find(ct => ct.name === item.contentType);
        const cId = item.topicId + '__' + (cType ? cType.id : item.contentType);
        if (!pubIds.includes(cId)) {
          pubIds.push(cId);
          await kvStore.put('published_topics', JSON.stringify(pubIds));
        }
        // 발행 로그 업데이트
        const pLogsRaw = await kvStore.get('publish_logs');
        const pLogs = pLogsRaw ? JSON.parse(pLogsRaw) : [];
        const existing = pLogs.find(l => l.title === item.title);
        if (existing) {
          existing.status = 'published';
          existing.wpLink = wpR.link || '';
          existing.publishedAt = new Date().toISOString();
        } else {
          pLogs.unshift({ comboId: cId, topicName: item.topic, contentType: item.contentType, title: item.title, wpLink: wpR.link || '', status: 'published', publishedAt: new Date().toISOString() });
        }
        await kvStore.put('publish_logs', JSON.stringify(pLogs.slice(0, 100)));

        jsonRes(res, { success: true, item });
      } catch(e) { jsonRes(res, { error: e.message }, 500); }
      return;
    }
    if (path.match(/^\/api\/client\/contents\/[^/]+\/reject$/) && method === 'POST') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = path.split('/')[4];
      const queue = await getQueue();
      const item = queue.find(i => i.id === itemId && i.status === 'pending');
      if (!item) { jsonRes(res, { error: 'Not found' }, 404); return; }
      item.status = 'rejected'; item.rejectedAt = new Date().toISOString();
      await saveQueue(queue);
      jsonRes(res, { success: true, item });
      autoPublish().catch(e => console.error('Regen error:', e));
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
async function getQueue() {
  const r = await kvStore.get('contentQueue');
  return r ? JSON.parse(r) : [];
}
async function saveQueue(q) { await kvStore.put('contentQueue', JSON.stringify(q)); }

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

server.listen(PORT, () => {
  console.log(`\n[Server] 화접몽 GEO Auto-Publisher 실행 중`);
  console.log(`[Server] 대시보드: http://localhost:${PORT}/dashboard`);
  console.log(`[Server] API: http://localhost:${PORT}/api/status\n`);
});
