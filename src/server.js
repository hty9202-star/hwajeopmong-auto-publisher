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
import cron from 'node-cron';
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
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinictest.wordpress.com',
  WP_ACCESS_TOKEN: process.env.WP_ACCESS_TOKEN,
  PEXELS_API_KEY: process.env.PEXELS_API_KEY,
  HWJ_KV: kvStore,
};

// ─── 자동 발행 로직 ───
async function autoPublish() {
  console.log(`\n[Cron] 자동 발행 시작: ${new Date().toISOString()}`);

  try {
    const publishedRaw = await kvStore.get('published_topics');
    const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
    const { topic, contentType, comboId, isRepublish } = getNextTopic(publishedTopicIds);

    console.log(`[Cron] 토픽: ${topic.name} - ${contentType.name}`);

    const content = await generateContent(env, topic, contentType);
    const result = await publishToWordPress(env, content);

    if (!isRepublish) {
      publishedTopicIds.push(comboId);
      await kvStore.put('published_topics', JSON.stringify(publishedTopicIds));
    }

    // 로그 저장
    const logsRaw = await kvStore.get('publish_logs');
    const logs = logsRaw ? JSON.parse(logsRaw) : [];
    logs.unshift({
      comboId,
      topicName: topic.name,
      contentType: contentType.name,
      title: content.title,
      wpLink: result.link,
      wpId: result.id,
      status: result.status,
      publishedAt: new Date().toISOString(),
    });
    await kvStore.put('publish_logs', JSON.stringify(logs.slice(0, 100)));

    console.log(`[Cron] 발행 완료: ${result.link}\n`);
  } catch (error) {
    console.error(`[Cron] 발행 실패:`, error.message);

    const errorsRaw = await kvStore.get('error_logs');
    const errors = errorsRaw ? JSON.parse(errorsRaw) : [];
    errors.unshift({ message: error.message, timestamp: new Date().toISOString() });
    await kvStore.put('error_logs', JSON.stringify(errors.slice(0, 50)));
  }
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

    // API: Status
    if (path === '/api/status') {
      const wp = await checkConnection(env);
      const publishedRaw = await kvStore.get('published_topics');
      const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
      const total = TOPICS.length * CONTENT_TYPES.length;

      return jsonRes(res, {
        brand: BRAND.name,
        wordpress: wp,
        ai: { model: 'gpt-4o-mini', status: env.OPENAI_API_KEY ? 'configured' : 'missing' },
        pexels: { status: env.PEXELS_API_KEY ? 'configured' : 'missing' },
        content: {
          totalTopics: TOPICS.length,
          totalContentTypes: CONTENT_TYPES.length,
          totalCombinations: total,
          published: publishedTopicIds.length,
          remaining: total - publishedTopicIds.length,
          progress: `${Math.round((publishedTopicIds.length / total) * 100)}%`,
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

    // 404
    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    console.error('Server error:', error);
    jsonRes(res, { error: error.message }, 500);
  }
});

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

server.listen(PORT, () => {
  console.log(`\n[Server] 화접몽 GEO Auto-Publisher 실행 중`);
  console.log(`[Server] 대시보드: http://localhost:${PORT}/dashboard`);
  console.log(`[Server] API: http://localhost:${PORT}/api/status\n`);
});
