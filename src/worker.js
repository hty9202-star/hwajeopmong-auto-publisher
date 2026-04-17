/**
 * 화접몽 한의원 GEO Auto-Publisher — Cloudflare Workers 메인 엔트리
 *
 * 두 가지 모드로 동작:
 * 1. Cron Trigger: 매일 09:00, 14:00 KST에 자동 콘텐츠 생성·발행
 * 2. HTTP Handler: 대시보드 + API 엔드포인트
 *
 * Railway 호환: server.js에서 동일 로직을 node-cron으로 실행 가능
 */

import { TOPICS, CONTENT_TYPES, BRAND, getNextTopic } from './config.js';
import { generateContent } from './content-generator.js';
import { publishToWordPress, getRecentPosts, checkConnection } from './wordpress-publisher.js';
import DASHBOARD_HTML from './dashboard.html';

// ─── Cron Trigger (자동 발행) ───
async function handleScheduled(event, env, ctx) {
  console.log(`[Cron] 자동 발행 트리거: ${new Date().toISOString()}`);

  try {
    // KV에서 발행 이력 가져오기
    const publishedRaw = await env.HWJ_KV.get('published_topics');
    const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];

    // 다음 토픽 선택
    const { topic, contentType, comboId, isRepublish } = getNextTopic(publishedTopicIds);
    console.log(`[Cron] 선택된 토픽: ${topic.name} - ${contentType.name} (재발행: ${isRepublish})`);

    // 콘텐츠 생성 (3단계 파이프라인)
    const content = await generateContent(env, topic, contentType);

    // WordPress 발행
    const result = await publishToWordPress(env, content);

    // 발행 이력 업데이트
    if (!isRepublish) {
      publishedTopicIds.push(comboId);
      await env.HWJ_KV.put('published_topics', JSON.stringify(publishedTopicIds));
    }

    // 발행 로그 저장
    const logsRaw = await env.HWJ_KV.get('publish_logs');
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
      isRepublish,
    });
    // 최근 100개만 보관
    await env.HWJ_KV.put('publish_logs', JSON.stringify(logs.slice(0, 100)));

    console.log(`[Cron] 발행 완료: ${result.link}`);
  } catch (error) {
    console.error(`[Cron] 발행 실패:`, error);

    // 에러 로그 저장
    const errorsRaw = await env.HWJ_KV.get('error_logs');
    const errors = errorsRaw ? JSON.parse(errorsRaw) : [];
    errors.unshift({
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
    await env.HWJ_KV.put('error_logs', JSON.stringify(errors.slice(0, 50)));
  }
}

// ─── HTTP Handler (대시보드 + API) ───
async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 헤더
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ─── 대시보드 ───
    if (path === '/' || path === '/dashboard') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // ─── API: 시스템 상태 ───
    if (path === '/api/status') {
      const wp = await checkConnection(env);
      const publishedRaw = await env.HWJ_KV.get('published_topics');
      const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
      const totalCombinations = TOPICS.length * CONTENT_TYPES.length;

      return jsonResponse({
        brand: BRAND.name,
        wordpress: wp,
        ai: { model: 'gpt-4o-mini', status: env.OPENAI_API_KEY ? 'configured' : 'missing' },
        pexels: { status: env.PEXELS_API_KEY ? 'configured' : 'missing' },
        content: {
          totalTopics: TOPICS.length,
          totalContentTypes: CONTENT_TYPES.length,
          totalCombinations,
          published: publishedTopicIds.length,
          remaining: totalCombinations - publishedTopicIds.length,
          progress: `${Math.round((publishedTopicIds.length / totalCombinations) * 100)}%`,
        },
        nextTopic: getNextTopic(publishedTopicIds),
        uptime: new Date().toISOString(),
      }, corsHeaders);
    }

    // ─── API: 토픽 목록 ───
    if (path === '/api/topics') {
      const publishedRaw = await env.HWJ_KV.get('published_topics');
      const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];

      const topicStatus = TOPICS.map((topic) => ({
        ...topic,
        contentStatus: CONTENT_TYPES.map((ct) => ({
          type: ct.name,
          comboId: `${topic.id}__${ct.id}`,
          published: publishedTopicIds.includes(`${topic.id}__${ct.id}`),
        })),
      }));

      return jsonResponse(topicStatus, corsHeaders);
    }

    // ─── API: 최근 발행 목록 ───
    if (path === '/api/recent-posts') {
      const logsRaw = await env.HWJ_KV.get('publish_logs');
      const logs = logsRaw ? JSON.parse(logsRaw) : [];
      return jsonResponse(logs, corsHeaders);
    }

    // ─── API: 에러 로그 ───
    if (path === '/api/errors') {
      const errorsRaw = await env.HWJ_KV.get('error_logs');
      const errors = errorsRaw ? JSON.parse(errorsRaw) : [];
      return jsonResponse(errors, corsHeaders);
    }

    // ─── API: 수동 발행 (POST) ───
    if (path === '/api/publish-now' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));

      // 특정 토픽 + 콘텐츠 유형 지정 가능
      let topic, contentType;

      if (body.topicId && body.contentTypeId) {
        topic = TOPICS.find((t) => t.id === body.topicId);
        contentType = CONTENT_TYPES.find((ct) => ct.id === body.contentTypeId);
      }

      if (!topic || !contentType) {
        const publishedRaw = await env.HWJ_KV.get('published_topics');
        const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
        const next = getNextTopic(publishedTopicIds);
        topic = next.topic;
        contentType = next.contentType;
      }

      // 비동기로 발행 실행 (타임아웃 방지)
      ctx.waitUntil(
        (async () => {
          try {
            const content = await generateContent(env, topic, contentType);
            const result = await publishToWordPress(env, content);

            // 이력 업데이트
            const publishedRaw = await env.HWJ_KV.get('published_topics');
            const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
            const comboId = `${topic.id}__${contentType.id}`;
            if (!publishedTopicIds.includes(comboId)) {
              publishedTopicIds.push(comboId);
              await env.HWJ_KV.put('published_topics', JSON.stringify(publishedTopicIds));
            }

            // 로그 저장
            const logsRaw = await env.HWJ_KV.get('publish_logs');
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
              manual: true,
            });
            await env.HWJ_KV.put('publish_logs', JSON.stringify(logs.slice(0, 100)));
          } catch (error) {
            console.error('수동 발행 실패:', error);
            const errorsRaw = await env.HWJ_KV.get('error_logs');
            const errors = errorsRaw ? JSON.parse(errorsRaw) : [];
            errors.unshift({
              message: error.message,
              timestamp: new Date().toISOString(),
              manual: true,
            });
            await env.HWJ_KV.put('error_logs', JSON.stringify(errors.slice(0, 50)));
          }
        })()
      );

      return jsonResponse({
        message: '발행 시작됨',
        topic: topic.name,
        contentType: contentType.name,
      }, corsHeaders);
    }

    // ─── API: 발행 이력 초기화 (POST) ───
    if (path === '/api/reset-history' && request.method === 'POST') {
      await env.HWJ_KV.put('published_topics', '[]');
      return jsonResponse({ message: '발행 이력 초기화 완료' }, corsHeaders);
    }

    // ─── 404 ───
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  } catch (error) {
    return jsonResponse({ error: error.message }, corsHeaders, 500);
  }
}

function jsonResponse(data, corsHeaders = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

// ─── Worker Export ───
export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
};
