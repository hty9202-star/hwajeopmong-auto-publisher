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
import { generateContent, calculateGeoScore, calculateEeatScore } from './content-generator.js';
import { publishToWordPress, getRecentPosts, checkConnection } from './wordpress-publisher.js';
import { contentQueue, publishLogs, publishedTopics, settings, topics as topicsDB, citationResults, testConnection as testSupabase } from './supabase-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// env 객체 (WordPress, Gemini 등 외부 API용)
const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinictest.wordpress.com',
  WP_ACCESS_TOKEN: process.env.WP_ACCESS_TOKEN,
  PEXELS_API_KEY: process.env.PEXELS_API_KEY,
};

// ─── 발행 모드에 따른 다음 토픽 선택 (공용) ───
async function resolveNextTopic(allTopics) {
  if (!allTopics || allTopics.length === 0) return null;

  const publish = await settings.get('publish') || {};
  const publishMode = publish.publishMode || 'auto';
  const idxData = await settings.get('topicIndex');
  const topicIdx = idxData ? parseInt(idxData) : 0;
  const ctIdxData = await settings.get('contentTypeIndex');
  const ctIdx = ctIdxData ? parseInt(ctIdxData) : 0;

  // 개별 질환 지정
  if (publish.nextTopic && !['auto','random','balanced','sequential'].includes(publish.nextTopic)) {
    const selected = allTopics.find(function(t) { return t.id === publish.nextTopic; });
    if (selected) return { topic: selected, contentType: CONTENT_TYPES[ctIdx % CONTENT_TYPES.length], mode: 'manual' };
  }

  if (publishMode === 'random') {
    return { topic: allTopics[topicIdx % allTopics.length], contentType: CONTENT_TYPES[ctIdx % CONTENT_TYPES.length], mode: 'random' };
  }
  if (publishMode === 'balanced') {
    const counts = {};
    for (const t of allTopics) counts[t.id] = 0;
    const allQueue = await contentQueue.getAll();
    for (const item of (allQueue || [])) {
      if (counts[item.topic_id] !== undefined) counts[item.topic_id]++;
    }
    const sorted = [...allTopics].sort(function(a, b) { return (counts[a.id] || 0) - (counts[b.id] || 0); });
    return { topic: sorted[0], contentType: CONTENT_TYPES[ctIdx % CONTENT_TYPES.length], mode: 'balanced' };
  }
  // auto / sequential
  return { topic: allTopics[topicIdx % allTopics.length], contentType: CONTENT_TYPES[ctIdx % CONTENT_TYPES.length], mode: publishMode };
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
    const publish = await settings.get('publish') || {};
    const publishMode = publish.publishMode || 'auto';

    // 발행 기간 체크
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (publish.startDate && today < publish.startDate) {
      console.log('[발행 대기] 시작일(' + publish.startDate + ') 전입니다. 발행 건너뜀.');
      return;
    }
    if (publish.endDate && today > publish.endDate) {
      console.log('[계약 종료] 종료일(' + publish.endDate + ')이 지났습니다. 발행 건너뜀.');
      return;
    }

    // 토픽/콘텐츠유형 선택 (공용 함수)
    const next = await resolveNextTopic(allTopics);
    if (!next) { console.log('No topic resolved'); return; }
    const { topic, contentType } = next;

    // 인덱스 로드 (발행 후 업데이트용)
    const idxData = await settings.get('topicIndex');
    let topicIdx = idxData ? parseInt(idxData) : 0;
    const ctIdxData = await settings.get('contentTypeIndex');
    let ctIdx = ctIdxData ? parseInt(ctIdxData) : 0;

    console.log('Generating: ' + topic.name + ' / ' + contentType.name);
    const comboId = topic.id + '__' + contentType.id;
    const existingTitles = await contentQueue.getTitlesByComboId(comboId);
    if (existingTitles.length > 0) {
      console.log('[중복 방지] 기존 ' + existingTitles.length + '건 제목 회피: ' + existingTitles.join(', '));
    }
    const result = await generateContent(process.env, topic, contentType, { existingTitles });

    if (result && result.content) {

      // 검수 결과 로깅
      const review = result.review || { total: 0, high: 0, medium: 0, status: 'clean' };
      if (review.total > 0) {
        console.log('[검수 완료] ' + review.total + '건 자동 치환 (의료법: ' + review.high + ', 과장광고: ' + review.medium + ')');
      }

      // GEO / E-E-A-T 품질 점수
      const geo = result.geoScore || { score: 0, details: {} };
      const eeat = result.eeatScore || { score: 0, details: {} };
      if (geo.score || eeat.score) {
        console.log('[품질] GEO: ' + geo.score + '/100, E-E-A-T: ' + eeat.score + '/100');
      }

      // Supabase에 콘텐츠 추가 (검수 결과 + 품질 점수 포함)
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
        hero_image_url: (result.heroImage && result.heroImage.url) ? result.heroImage.url : null,
        schemas: result.schemas || null,
        faq: result.faq || null,
        review_status: review.status,
        review_fixes: review.total,
        geo_score: geo.score || 0,
        eeat_score: eeat.score || 0,
        geo_details: geo.details || {},
        eeat_details: eeat.details || {},
        status: 'pending',
      });

      var queueId = (inserted && inserted[0] && inserted[0].id) ? inserted[0].id : null;
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

      // 인덱스 업데이트 (발행 모드에 따라 다름)
      if (publishMode === 'sequential') {
        topicIdx = topicIdx + 1;
        if (topicIdx >= allTopics.length) {
          topicIdx = 0;
          ctIdx = (ctIdx + 1) % CONTENT_TYPES.length;
        }
      } else if (publishMode === 'random') {
        topicIdx = (topicIdx + 1) % allTopics.length;
        ctIdx = (ctIdx + 1) % CONTENT_TYPES.length;
      } else if (publishMode === 'balanced') {
        ctIdx = (ctIdx + 1) % CONTENT_TYPES.length;
      } else {
        topicIdx = (topicIdx + 1) % allTopics.length;
        ctIdx = (ctIdx + 1) % CONTENT_TYPES.length;
      }
      await settings.set('topicIndex', topicIdx);
      await settings.set('contentTypeIndex', ctIdx);

      // 개별 질환 지정이었으면 리셋
      if (publish.nextTopic && !['auto','random','balanced','sequential'].includes(publish.nextTopic)) {
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
let schedulerEnabled = true;

async function setupCronSchedule() {
  activeCronJobs.forEach(function(job) { job.stop(); });
  activeCronJobs = [];

  const publishSettings = await settings.get('publish') || {};
  const frequency = publishSettings.publishFrequency || '5';
  const days = publishSettings.publishDays || 'everyday';

  const crons = FREQUENCY_PRESETS[frequency] || FREQUENCY_PRESETS['5'];

  crons.forEach(function(cronExpr) {
    const finalExpr = days === 'weekdays' ? cronExpr.replace(/\*$/, '1-5') : cronExpr;
    const job = cron.schedule(finalExpr, autoPublish, { timezone: 'Asia/Seoul' });
    activeCronJobs.push(job);
  });

  const daysLabel = days === 'weekdays' ? '평일만' : '매일';
  console.log('[Server] Cron 스케줄 등록: ' + daysLabel + ' ' + (FREQUENCY_LABELS[frequency] || FREQUENCY_LABELS['5']));
}

setupCronSchedule();

// ─── 다음 발행 예정 시간 계산 (KST 문자열 반환) ───
async function getNextPublishTime() {
  const publishSettings = await settings.get('publish') || {};
  const frequency = publishSettings.publishFrequency || '5';
  const days = publishSettings.publishDays || 'everyday';
  const crons = FREQUENCY_PRESETS[frequency] || FREQUENCY_PRESETS['5'];

  const hours = crons.map(function(c) { return parseInt(c.split(' ')[1]); });
  hours.sort(function(a, b) { return a - b; });

  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  const currentHour = kstNow.getUTCHours();
  const currentMin = kstNow.getUTCMinutes();
  const currentDay = kstNow.getUTCDay();

  const isWeekday = currentDay >= 1 && currentDay <= 5;
  const weekdaysOnly = days === 'weekdays';

  let nextHour = null;
  for (const h of hours) {
    if (h > currentHour || (h === currentHour && currentMin === 0)) {
      nextHour = h;
      break;
    }
  }

  // 발행 기간 체크: startDate가 미래이면 startDate 기준으로 계산
  const publishStartDate = publishSettings.startDate;
  const publishEndDate = publishSettings.endDate;
  const todayStr = kstNow.getUTCFullYear() + '-' + String(kstNow.getUTCMonth()+1).padStart(2,'0') + '-' + String(kstNow.getUTCDate()).padStart(2,'0');

  // 발행 기간이 끝났으면 null 반환
  if (publishEndDate && todayStr > publishEndDate) {
    return null;
  }

  let targetDate = new Date(kstNow);
  if (nextHour !== null && (!weekdaysOnly || isWeekday)) {
    targetDate.setUTCHours(nextHour, 0, 0, 0);
  } else {
    targetDate.setUTCDate(targetDate.getUTCDate() + 1);
    targetDate.setUTCHours(hours[0], 0, 0, 0);
    if (weekdaysOnly) {
      while (targetDate.getUTCDay() === 0 || targetDate.getUTCDay() === 6) {
        targetDate.setUTCDate(targetDate.getUTCDate() + 1);
      }
    }
  }

  // 발행 시작일이 미래이면 시작일의 첫 발행 시간으로 조정
  if (publishStartDate && todayStr < publishStartDate) {
    const parts = publishStartDate.split('-');
    targetDate.setUTCFullYear(parseInt(parts[0]));
    targetDate.setUTCMonth(parseInt(parts[1]) - 1);
    targetDate.setUTCDate(parseInt(parts[2]));
    targetDate.setUTCHours(hours[0], 0, 0, 0);
    if (weekdaysOnly) {
      while (targetDate.getUTCDay() === 0 || targetDate.getUTCDay() === 6) {
        targetDate.setUTCDate(targetDate.getUTCDate() + 1);
      }
    }
  }

  const y = targetDate.getUTCFullYear();
  const m = targetDate.getUTCMonth() + 1;
  const d = targetDate.getUTCDate();
  const h = String(targetDate.getUTCHours()).padStart(2, '0');
  const dayNames = ['일','월','화','수','목','금','토'];
  const dayName = dayNames[targetDate.getUTCDay()];

  return { date: m + '/' + d + '(' + dayName + ')', time: h + ':00', full: y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0') + 'T' + h + ':00:00+09:00' };
}

// ─── HTTP 서버 ───
const server = http.createServer(async function(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
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
      const html = fs.readFileSync(__dirname + '/dashboard.html', 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // Settings page
    if (pathname === '/settings') {
      const html = fs.readFileSync(__dirname + '/settings.html', 'utf-8');
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

      // 발행 기간 내 콘텐츠만 카운트
      let periodPublished = publishedComboIds.length;
      if (publishSettings.startDate) {
        const allQueue = await contentQueue.getAll();
        periodPublished = (allQueue || []).filter(function(item) {
          if (!item.created_at) return false;
          const created = item.created_at.split('T')[0];
          if (publishSettings.startDate && created < publishSettings.startDate) return false;
          if (publishSettings.endDate && created > publishSettings.endDate) return false;
          return true;
        }).length;
      }

      const nextTopic = await resolveNextTopic(allTopics);
      const nextPublishTime = await getNextPublishTime();

      // 발행 기간 정보 계산
      const todayStr = new Date().toISOString().split('T')[0];
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
          else if (daysLeft <= 7) status = 'expiring';
        }
        let totalDays = null, elapsedDays = null, pacePercent = null;
        if (startDate && endDate) {
          totalDays = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000*60*60*24));
          if (todayStr >= startDate) {
            elapsedDays = Math.ceil((new Date(todayStr) - new Date(startDate)) / (1000*60*60*24));
            if (elapsedDays > totalDays) elapsedDays = totalDays;
            pacePercent = totalDays > 0 ? Math.round((elapsedDays / totalDays) * 100) : 0;
          } else {
            elapsedDays = 0;
            pacePercent = 0;
          }
        }
        publishPeriod = { startDate: startDate, endDate: endDate, status: status, daysLeft: daysLeft, totalDays: totalDays, elapsedDays: elapsedDays, pacePercent: pacePercent };
      }

      return jsonRes(res, {
        brand: BRAND.name,
        wordpress: wp,
        supabase: sb,
        nextPublishTime: nextPublishTime,
        publishPeriod: publishPeriod,
        ai: { model: 'gemini-2.5-flash-lite', status: env.GEMINI_API_KEY ? 'configured' : 'missing' },
        pexels: { status: env.PEXELS_API_KEY ? 'configured' : 'missing' },
        content: {
          totalTopics: topicCount,
          totalContentTypes: CONTENT_TYPES.length,
          totalCombinations: total,
          totalTarget: totalTarget,
          published: periodPublished,
          publishedAll: publishedComboIds.length,
          remaining: totalTarget - periodPublished,
          progress: Math.round((periodPublished / totalTarget) * 100) + '%',
        },
        nextTopic: nextTopic,
      });
    }

    // API: Topics (DB 기반)
    if (pathname === '/api/topics' && method === 'GET') {
      const publishedComboIds = await publishedTopics.getComboIds();
      const allTopics = await topicsDB.getAll();
      const topicStatus = (allTopics || []).map(function(topic) {
        return {
          id: topic.id, name: topic.name, nameEn: topic.nameEn, slug: topic.slug, category: topic.category,
          keywords: topic.keywords || [], medicalName: topic.medicalName, icd10: topic.icd10,
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
      return jsonRes(res, topicStatus);
    }

    // API: Topic CRUD
    if (pathname === '/api/topics' && method === 'POST') {
      let body = '';
      req.on('data', function(ch) { body += ch; });
      req.on('end', async function() {
        try {
          const data = JSON.parse(body);
          if (!data.slug) data.slug = data.id;
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
      req.on('data', function(ch) { body += ch; });
      req.on('end', async function() {
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
      req.on('data', function(ch) { body += ch; });
      req.on('end', async function() {
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
      return jsonRes(res, { data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages, counts: counts });
    }

    // API: Errors
    if (pathname === '/api/errors') {
      const errorData = await settings.get('error_logs');
      return jsonRes(res, errorData || []);
    }

    // API: Publish Now - 1회 테스트 발행 (POST)
    if (pathname === '/api/publish-now' && method === 'POST') {
      const allTopicsForPublish = await topicsDB.getAll();
      const next = await resolveNextTopic(allTopicsForPublish);

      autoPublish().catch(console.error);

      return jsonRes(res, {
        message: '발행 시작됨',
        topic: next ? next.topic.name : '없음',
        contentType: next ? next.contentType.name : '없음',
      });
    }

    // API: Scheduler Toggle (POST) - 스케줄 ON/OFF
    if (pathname === '/api/scheduler-toggle' && method === 'POST') {
      var toggleBody = '';
      await new Promise(function(resolve) {
        req.on('data', function(chunk) { toggleBody += chunk; });
        req.on('end', resolve);
      });
      var toggleData = JSON.parse(toggleBody || '{}');
      if (typeof toggleData.enabled === 'boolean') {
        schedulerEnabled = toggleData.enabled;
        if (schedulerEnabled) {
          await setupCronSchedule();
          console.log('[Server] 스케줄 발행 활성화');
        } else {
          activeCronJobs.forEach(function(job) { job.stop(); });
          activeCronJobs = [];
          console.log('[Server] 스케줄 발행 비활성화');
        }
      }
      return jsonRes(res, { success: true, schedulerEnabled: schedulerEnabled });
    }

    // API: Scheduler Status (GET)
    if (pathname === '/api/scheduler-status' && method === 'GET') {
      return jsonRes(res, { schedulerEnabled: schedulerEnabled, activeJobs: activeCronJobs.length });
    }

    // API: Get Settings
    if (pathname === '/api/settings' && method === 'GET') {
      const publishData = await settings.get('publish') || {};
      const defaultPublish = { publishFrequency: '5', publishDays: 'everyday', publishMode: 'auto', totalTarget: 50, nextTopic: 'auto', imagesPerContent: 3 };
      var publishMerged = {};
      Object.keys(defaultPublish).forEach(function(k) { publishMerged[k] = defaultPublish[k]; });
      Object.keys(publishData).forEach(function(k) { publishMerged[k] = publishData[k]; });

      const allTopics = await topicsDB.getAll();
      const topicsList = (allTopics || []).map(function(t) {
        return { id: t.id, name: t.name, category: t.category, keywords: t.keywords || [] };
      });
      return jsonRes(res, { publish: publishMerged, topics: topicsList });
    }

    // API: Save Settings
    if (pathname === '/api/settings' && method === 'POST') {
      let body = '';
      req.on('data', function(chunk) { body += chunk; });
      req.on('end', async function() {
        try {
          const data = JSON.parse(body);
          if (data.publish) {
            await settings.set('publish', data.publish);
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
        const images = (pData.photos || []).map(function(p) {
          return { id: p.id, url: p.src.medium, alt: p.alt || query, photographer: p.photographer, pexelsUrl: p.url };
        });
        return jsonRes(res, { images: images, total: pData.total_results || 0 });
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
      } catch (e) { item = null; }
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
      req.on('data', function(ch) { body += ch; });
      req.on('end', function() {
        try {
          const parsed = JSON.parse(body);
          const cid = process.env.CLIENT_ID || 'hwajeopmong';
          const cpw = process.env.CLIENT_PASSWORD || 'hwj2024!';
          if (parsed.id === cid && parsed.password === cpw) {
            const tk = genToken();
            CLIENT_TOKENS.set(tk, { id: parsed.id, at: new Date().toISOString() });
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
      jsonRes(res, { data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages, counts: counts });
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

      await publishLogs.updateByQueueId(itemId, {
        status: 'rejected',
      });

      jsonRes(res, { success: true });

      autoPublish().catch(function(e) { console.error('Regen error:', e); });
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

    // --- 품질 점수 재계산 API ---
    if (pathname === '/api/recalculate-scores' && method === 'POST') {
      const all = await contentQueue.getAll();
      let updated = 0;
      for (const item of (all || [])) {
        if (!item.content) continue;
        const geo = calculateGeoScore(item.content, item.title || '', item.meta_description || '', item.faq || [], item.schemas || {});
        const eeat = calculateEeatScore(item.content, item.title || '');
        await contentQueue.updateStatus(item.id, item.status, {
          geo_score: geo.score,
          eeat_score: eeat.score,
          geo_details: geo.details,
          eeat_details: eeat.details,
        });
        updated++;
      }
      jsonRes(res, { success: true, updated: updated, message: updated + '건 점수 재계산 완료' });
      return;
    }

    // --- 품질 점수 API ---
    if (pathname === '/api/quality-scores' && method === 'GET') {
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

    // === 인용 추적 API ===

    // GET: 인용추적 설정 조회
    if (pathname === '/api/citation-settings' && method === 'GET') {
      const citationSettings = await settings.get('citation') || {};
      var citDefaults = {
        chatgptApiKey: '',
        claudeApiKey: '',
        geminiApiKey: env.GEMINI_API_KEY ? '(서버 설정됨)' : '',
        questionTemplates: [
          '{disease} 치료 잘하는 한의원 추천해줘',
          '{disease} 한방 치료 효과 있어?',
          '{disease} 치료 후기 알려줘',
        ],
        trackingFrequency: 'weekly',
        repeatCount: 3,
      };
      var citResult = {};
      Object.keys(citDefaults).forEach(function(k) { citResult[k] = citDefaults[k]; });
      Object.keys(citationSettings).forEach(function(k) { citResult[k] = citationSettings[k]; });
      return jsonRes(res, citResult);
    }

    // POST: 인용추적 설정 저장
    if (pathname === '/api/citation-settings' && method === 'POST') {
      let body = '';
      req.on('data', function(ch) { body += ch; });
      req.on('end', async function() {
        try {
          const data = JSON.parse(body);
          await settings.set('citation', data);
          jsonRes(res, { success: true });
        } catch (e) { jsonRes(res, { error: e.message }, 400); }
      });
      return;
    }

    // GET: 인용추적 결과 조회
    if (pathname === '/api/citation-results' && method === 'GET') {
      const results = await citationResults.getRecent(100);
      return jsonRes(res, results || []);
    }

    // POST: 인용 추적 실행
    if (pathname === '/api/citation-track' && method === 'POST') {
      let body = '';
      req.on('data', function(ch) { body += ch; });
      req.on('end', async function() {
        try {
          const parsed = JSON.parse(body);
          var topicIds = parsed.topicIds;
          const citationSettings = await settings.get('citation') || {};
          const allTopics = await topicsDB.getAll();
          const targetTopics = topicIds && topicIds.length > 0
            ? allTopics.filter(function(t) { return topicIds.includes(t.id); })
            : allTopics;

          const templates = citationSettings.questionTemplates || [
            '{disease} 치료 잘하는 한의원 추천해줘',
          ];
          const repeatCount = citationSettings.repeatCount || 3;

          const trackingResults = [];
          const models = [];

          if (env.GEMINI_API_KEY) models.push('gemini');
          if (citationSettings.chatgptApiKey) models.push('chatgpt');
          if (citationSettings.claudeApiKey) models.push('claude');

          for (const topic of targetTopics) {
            for (const model of models) {
              let mentionCount = 0;
              let citCount = 0;
              let totalQuestions = 0;

              for (const template of templates) {
                const question = template.replace(/\{disease\}/g, topic.name);
                for (let r = 0; r < repeatCount; r++) {
                  totalQuestions++;
                  try {
                    const answer = await askAI(model, question, citationSettings);
                    var brandName = '화접몽';
                    var mentioned = answer.indexOf(brandName) >= 0 || answer.indexOf('화접몽 한의원') >= 0;
                    if (mentioned) {
                      mentionCount++;
                      var citMatches = answer.match(/화접몽/g);
                      citCount += citMatches ? citMatches.length : 0;
                    }
                  } catch (e) {
                    console.error('[인용추적] ' + model + ' 에러:', e.message);
                  }
                }
              }

              var score = totalQuestions > 0 ? Math.round((mentionCount / totalQuestions) * 100) : 0;
              trackingResults.push({
                topic_id: topic.id,
                topic_name: topic.name,
                ai_model: model,
                score: score,
                mention_count: mentionCount,
                citation_count: citCount,
                total_questions: totalQuestions,
                tracked_at: new Date().toISOString(),
              });
            }
          }

          if (trackingResults.length > 0) {
            await citationResults.addBulk(trackingResults);
          }

          jsonRes(res, { success: true, results: trackingResults, message: targetTopics.length + '개 질환 x ' + models.length + '개 AI 추적 완료' });
        } catch (e) {
          console.error('[인용추적] 오류:', e);
          jsonRes(res, { error: e.message }, 500);
        }
      });
      return;
    }

    // API: Monthly Report (GET)
    if (pathname === '/api/report' && method === 'GET') {
      var rStartDate = url.searchParams.get('startDate');
      var rEndDate = url.searchParams.get('endDate');
      if (!rStartDate || !rEndDate) {
        return jsonRes(res, { error: 'startDate, endDate 필수' }, 400);
      }
      try {
      var logs = await publishLogs.getByDateRange(rStartDate, rEndDate) || [];
      var queue = await contentQueue.getByDateRange(rStartDate, rEndDate) || [];
      var citations = await citationResults.getByDateRange(rStartDate, rEndDate) || [];

      var publishedLogs = logs.filter(function(l) { return l.status === 'published' || l.status === 'success'; });
      var totalPublished = publishedLogs.length;

      var geoSum = 0; var eeatSum = 0; var scoredCount = 0;
      for (var qi = 0; qi < queue.length; qi++) {
        var q = queue[qi];
        if (q.geo_score || q.eeat_score) {
          geoSum += (q.geo_score || 0);
          eeatSum += (q.eeat_score || 0);
          scoredCount++;
        }
      }

      var topicStats = {};
      for (var li = 0; li < publishedLogs.length; li++) {
        var log = publishedLogs[li];
        var tn = log.topic_name || 'unknown';
        if (!topicStats[tn]) topicStats[tn] = { count: 0, geoSum: 0, eeatSum: 0, scored: 0 };
        topicStats[tn].count++;
      }
      for (var qi2 = 0; qi2 < queue.length; qi2++) {
        var q2 = queue[qi2];
        var tn2 = q2.topic_name || 'unknown';
        if (!topicStats[tn2]) topicStats[tn2] = { count: 0, geoSum: 0, eeatSum: 0, scored: 0 };
        if (q2.geo_score || q2.eeat_score) {
          topicStats[tn2].geoSum += (q2.geo_score || 0);
          topicStats[tn2].eeatSum += (q2.eeat_score || 0);
          topicStats[tn2].scored++;
        }
      }

      var modelStats = {};
      for (var ci = 0; ci < citations.length; ci++) {
        var c = citations[ci];
        if (!modelStats[c.ai_model]) modelStats[c.ai_model] = { scoreSum: 0, count: 0 };
        modelStats[c.ai_model].scoreSum += Number(c.score || 0);
        modelStats[c.ai_model].count++;
      }

      var weeklyData = {};
      for (var pi = 0; pi < publishedLogs.length; pi++) {
        var plog = publishedLogs[pi];
        var pdate = new Date(plog.created_at);
        var weekNum = Math.ceil(pdate.getDate() / 7);
        if (!weeklyData[weekNum]) weeklyData[weekNum] = { published: 0, geoSum: 0, eeatSum: 0, scored: 0 };
        weeklyData[weekNum].published++;
      }
      for (var qi3 = 0; qi3 < queue.length; qi3++) {
        var q3 = queue[qi3];
        var qdate = new Date(q3.created_at);
        var wn = Math.ceil(qdate.getDate() / 7);
        if (!weeklyData[wn]) weeklyData[wn] = { published: 0, geoSum: 0, eeatSum: 0, scored: 0 };
        if (q3.geo_score || q3.eeat_score) {
          weeklyData[wn].geoSum += (q3.geo_score || 0);
          weeklyData[wn].eeatSum += (q3.eeat_score || 0);
          weeklyData[wn].scored++;
        }
      }

      var weeklyCitation = {};
      for (var ci2 = 0; ci2 < citations.length; ci2++) {
        var c2 = citations[ci2];
        var cdate = new Date(c2.tracked_at);
        var cwn = Math.ceil(cdate.getDate() / 7);
        var ckey = cwn + '_' + c2.ai_model;
        if (!weeklyCitation[ckey]) weeklyCitation[ckey] = { model: c2.ai_model, week: cwn, scoreSum: 0, count: 0 };
        weeklyCitation[ckey].scoreSum += Number(c2.score || 0);
        weeklyCitation[ckey].count++;
      }

      return jsonRes(res, {
        period: { startDate: rStartDate, endDate: rEndDate },
        summary: {
          totalPublished: totalPublished,
          avgGeo: scoredCount > 0 ? Math.round(geoSum / scoredCount) : 0,
          avgEeat: scoredCount > 0 ? Math.round(eeatSum / scoredCount) : 0,
          avgCitation: Object.keys(modelStats).length > 0 ? Math.round(Object.values(modelStats).reduce(function(s, m) { return s + (m.count > 0 ? m.scoreSum / m.count : 0); }, 0) / Object.keys(modelStats).length) : 0,
        },
        topicStats: topicStats,
        modelStats: modelStats,
        weeklyData: weeklyData,
        weeklyCitation: Object.values(weeklyCitation),
        logs: publishedLogs,
        citations: citations,
      });
      } catch (reportErr) {
        console.error('Report API error:', reportErr);
        return jsonRes(res, { error: reportErr.message }, 500);
      }
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    console.error('Server error:', error);
    jsonRes(res, { error: error.message }, 500);
  }
});

// === AI \uc778\uc6a9 \ucd94\uc801\uc6a9 API \ud638\ucd9c ===
async function askAI(model, question, citationSettings) {
  citationSettings = citationSettings || {};

  if (model === 'gemini') {
    var geminiKey = env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error('Gemini API key not set');
    var gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey;
    var gResp = await fetch(gUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: question }] }] }),
    });
    var gData = await gResp.json();
    return (gData.candidates && gData.candidates[0] && gData.candidates[0].content && gData.candidates[0].content.parts && gData.candidates[0].content.parts[0] && gData.candidates[0].content.parts[0].text) || '';
  }

  if (model === 'chatgpt') {
    var chatKey = citationSettings.chatgptApiKey;
    if (!chatKey) throw new Error('ChatGPT API key not set');
    var cResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: question }] }),
    });
    var cData = await cResp.json();
    return (cData.choices && cData.choices[0] && cData.choices[0].message && cData.choices[0].message.content) || '';
  }

  if (model === 'claude') {
    var clKey = citationSettings.claudeApiKey;
    if (!clKey) throw new Error('Claude API key not set');
    var clResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': clKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: question }] }),
    });
    var clData = await clResp.json();
    return (clData.content && clData.content[0] && clData.content[0].text) || '';
  }

  throw new Error('Unknown AI model: ' + model);
}

// === Client Auth ===
var CLIENT_TOKENS = new Map();
function genToken() {
  var t = ''; var ch = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (var i = 0; i < 32; i++) t += ch[Math.floor(Math.random() * ch.length)];
  return t;
}
function verifyToken(req) {
  var a = req.headers['authorization'];
  if (!a) return false;
  return CLIENT_TOKENS.has(a.replace('Bearer ', ''));
}

function jsonRes(res, data, status) {
  status = status || 200;
  res.writeHead(status, { 'Content-Type': "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

server.listen(PORT, function() {
  console.log('[Server] 화접몽 GEO Auto-Publisher 실행 중 (Supabase DB)');
  console.log('[Server] 대시보드: http://localhost:' + PORT + '/dashboard');
  console.log('[Server] 광고주: http://localhost:' + PORT + '/client');
  console.log('[Server] API: http://localhost:' + PORT + '/api/status');
});
