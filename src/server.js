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

// HTML 파일 캐싱 (매 요청마다 readFileSync 방지)
const HTML_CACHE = {};
function getHtml(filename) {
  if (!HTML_CACHE[filename]) {
    HTML_CACHE[filename] = fs.readFileSync(__dirname + '/' + filename, 'utf-8');
  }
  return HTML_CACHE[filename];
}

// 공용 body 파싱 유틸
function parseBody(req) {
  return new Promise(function(resolve, reject) {
    let body = '';
    req.on('data', function(ch) { body += ch; });
    req.on('end', function() {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

// 공용 동시실행 제한 유틸
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let idx = 0;
  async function next() {
    const i = idx++;
    if (i >= tasks.length) return;
    results[i] = await tasks[i]();
    await next();
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, tasks.length); w++) workers.push(next());
  await Promise.all(workers);
  return results;
}

// 공용 AI 호출 타임아웃 래퍼
function askAIWithTimeout(model, question, s) {
  return Promise.race([
    askAI(model, question, s),
    new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout 30s')); }, 30000); })
  ]);
}

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
async function autoPublish(options) {
  var opts = options || {};
  var isTest = opts.isTest || false;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { console.log('No GEMINI_API_KEY'); return; }

    // DB에서 활성 토픽 로드
    const allTopics = await topicsDB.getAll();
    if (!allTopics || allTopics.length === 0) { console.log('No active topics'); return; }

    // 설정 로드
    const publish = await settings.get('publish') || {};
    const publishMode = publish.publishMode || 'auto';

    // 발행 기간 체크 (테스트 발행은 기간 체크 건너뜀, KST 기준)
    if (!isTest) {
      const kstDate = new Date(Date.now() + 9*60*60*1000);
      const today = kstDate.getUTCFullYear() + '-' + String(kstDate.getUTCMonth()+1).padStart(2,'0') + '-' + String(kstDate.getUTCDate()).padStart(2,'0');
      if (publish.startDate && today < publish.startDate) {
        console.log('[발행 대기] 시작일(' + publish.startDate + ') 전입니다. 발행 건너뜀.');
        return;
      }
      if (publish.endDate && today > publish.endDate) {
        console.log('[계약 종료] 종료일(' + publish.endDate + ')이 지났습니다. 발행 건너뜀.');
        return;
      }
    } else {
      console.log('[테스트 발행] 기간 체크 건너뜀');
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
      console.log((isTest ? '[테스트] ' : '') + 'Queued: ' + result.title + ' (ID: ' + queueId + ')');

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

      // 인덱스 업데이트 (테스트 발행은 인덱스 변경 안 함)
      if (!isTest) {
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
      } else {
        console.log('[테스트 발행] 인덱스 업데이트 건너뜀');
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

// ─── 인용추적 자동 cron ───
let citationCronJob = null;
let lastCitationTrackTime = null;

const CITATION_CRON_MAP = {
  'daily': '0 6 * * *',
  'weekly': '0 6 * * 1',
  'biweekly': '0 6 1,15 * *',
  'monthly': '0 6 1 * *',
};

async function autoTrackCitations() {
  try {
    console.log('[인용추적 자동] 시작');
    const citationSettings = await settings.get('citation') || {};
    const allTopics = await topicsDB.getAll();
    if (!allTopics || allTopics.length === 0) { console.log('[인용추적 자동] 활성 토픽 없음'); return; }

    const templates = citationSettings.questionTemplates || ['{disease} 치료 잘하는 한의원 추천해줘'];
    const repeatCount = citationSettings.repeatCount || 3;

    const trackingResults = [];
    const models = [];
    if (env.GEMINI_API_KEY) models.push('gemini');
    if (citationSettings.chatgptApiKey) models.push('chatgpt');
    if (citationSettings.claudeApiKey) models.push('claude');

    if (models.length === 0) { console.log('[인용추적 자동] 연동된 AI 모델 없음'); return; }

    const topicTasks = allTopics.map(function(topic) {
      return async function() {
        const topicResults = [];
        for (const model of models) {
          let mentionCount = 0, citCount = 0, totalQuestions = 0, sampleAnswer = '';
          const questionTasks = [];
          for (const template of templates) {
            const question = template.replace(/\{disease\}/g, topic.name);
            for (let r = 0; r < repeatCount; r++) {
              questionTasks.push({ model: model, question: question });
            }
          }
          const answers = await Promise.allSettled(
            questionTasks.map(function(qt) { return askAIWithTimeout(qt.model, qt.question, citationSettings); })
          );
          for (let ai = 0; ai < answers.length; ai++) {
            totalQuestions++;
            if (answers[ai].status === 'fulfilled') {
              var answer = answers[ai].value;
              if (!sampleAnswer && answer.length > 0) sampleAnswer = answer.substring(0, 500);
              if (answer.indexOf('화접몽') >= 0) {
                mentionCount++;
                var citMatches = answer.match(/화접몽/g);
                citCount += citMatches ? citMatches.length : 0;
              }
            } else {
              console.error('[인용추적 자동] ' + model + ' 에러:', answers[ai].reason.message);
            }
          }
          var score = totalQuestions > 0 ? Math.round((mentionCount / totalQuestions) * 100) : 0;
          topicResults.push({
            topic_id: topic.id, topic_name: topic.name, ai_model: model,
            score: score, mention_count: mentionCount, citation_count: citCount,
            total_questions: totalQuestions, tracked_at: new Date().toISOString(),
          });
        }
        return topicResults;
      };
    });

    const allResults = await runWithConcurrency(topicTasks, 2);
    for (let ri = 0; ri < allResults.length; ri++) {
      if (allResults[ri]) {
        for (let rj = 0; rj < allResults[ri].length; rj++) {
          trackingResults.push(allResults[ri][rj]);
        }
      }
    }

    if (trackingResults.length > 0) {
      await citationResults.addBulk(trackingResults);
    }

    lastCitationTrackTime = new Date().toISOString();
    console.log('[인용추적 자동] 완료: ' + trackingResults.length + '건 저장');
  } catch (e) {
    console.error('[인용추적 자동] 오류:', e);
  }
}

async function setupCitationCron() {
  if (citationCronJob) { citationCronJob.stop(); citationCronJob = null; }
  const citationSettings = await settings.get('citation') || {};
  if (citationSettings.enabled === false) {
    console.log('[Server] 인용추적 cron 비활성 (설정에서 OFF)');
    return;
  }
  const freq = citationSettings.trackingFrequency || 'weekly';
  const cronExpr = CITATION_CRON_MAP[freq] || CITATION_CRON_MAP['weekly'];
  citationCronJob = cron.schedule(cronExpr, autoTrackCitations, { timezone: 'Asia/Seoul' });
  citationCronJob._freq = freq;
  console.log('[Server] 인용추적 cron 등록: ' + freq + ' (' + cronExpr + ')');
}

setupCitationCron();

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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getHtml('dashboard.html'));
    }

    // Settings page
    if (pathname === '/settings') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getHtml('settings.html'));
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

      // 발행 기간 내 실제 WordPress 발행 건수만 카운트
      let periodPublished = publishedComboIds.length;
      if (publishSettings.startDate) {
        const periodLogs = await publishLogs.getByDateRange(
          publishSettings.startDate,
          publishSettings.endDate || '2099-12-31'
        );
        periodPublished = (periodLogs || []).filter(function(item) {
          return item.status === 'published' || item.status === 'success';
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
              var now = new Date();
              var kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
              var next = new Date(kst);
              next.setHours(6, 0, 0, 0);
              var freq = ((citationCronJob || {})._freq) || 'daily';
              if (freq === 'daily') {
                if (next <= kst) next.setDate(next.getDate() + 1);
              } else if (freq === 'weekly') {
                // 매주 월요일
                var day = kst.getDay();
                var daysUntilMon = (1 - day + 7) % 7 || 7;
                if (day === 1 && kst.getHours() < 6) daysUntilMon = 0;
                next.setDate(kst.getDate() + daysUntilMon);
              } else if (freq === 'biweekly') {
                // 1일, 15일
                var d = kst.getDate();
                if (d < 1 || (d === 1 && kst.getHours() < 6)) { next.setDate(1); }
                else if (d < 15 || (d === 15 && kst.getHours() < 6)) { next.setDate(15); }
                else { next.setMonth(next.getMonth() + 1); next.setDate(1); }
              } else if (freq === 'monthly') {
                // 매월 1일
                if (kst.getDate() > 1 || (kst.getDate() === 1 && kst.getHours() >= 6)) {
                  next.setMonth(next.getMonth() + 1);
                }
                next.setDate(1);
              } else {
                if (next <= kst) next.setDate(next.getDate() + 1);
              }
              return next.toISOString();
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
      return;
    }

    if (pathname.match(/^\/api\/topics\/[^/]+$/) && method === 'PUT') {
      const topicId = pathname.split('/')[3];
      try {
        const data = await parseBody(req);
        const result = await topicsDB.update(topicId, data);
        jsonRes(res, { success: true, data: result });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
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
      try {
        const { order } = await parseBody(req);
        await topicsDB.updateOrder(order);
        jsonRes(res, { success: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
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

      autoPublish({ isTest: true }).catch(console.error);

      return jsonRes(res, {
        message: '테스트 발행 시작됨 (기간/인덱스 영향 없음)',
        topic: next ? next.topic.name : '없음',
        contentType: next ? next.contentType.name : '없음',
      });
    }

    // API: Scheduler Toggle (POST) - 스케줄 ON/OFF
    if (pathname === '/api/scheduler-toggle' && method === 'POST') {
      var toggleData = await parseBody(req).catch(function() { return {}; });
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
      try {
        const data = await parseBody(req);
        if (data.publish) {
          await settings.set('publish', data.publish);
          await setupCronSchedule();
        }
        if (data.topics) await settings.set('topics', data.topics);
        return jsonRes(res, { success: true });
      } catch (e) {
        return jsonRes(res, { error: 'Invalid JSON' }, 400);
      }
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getHtml('client-login.html'));
    }
    if (pathname === '/client' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getHtml('client-dashboard.html'));
    }

    // --- Client API: Login ---
    if (pathname === '/api/client/login' && method === 'POST') {
      try {
        const parsed = await parseBody(req);
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
        enabled: true,
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
      try {
        const data = await parseBody(req);
        await settings.set('citation', data);
        await setupCitationCron();
        jsonRes(res, { success: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
      return;
    }

    // GET: 인용추적 결과 조회
    if (pathname === '/api/citation-results' && method === 'GET') {
      const results = await citationResults.getRecent(100);
      return jsonRes(res, results || []);
    }

    // POST: 인용 추적 실행
    if (pathname === '/api/citation-track' && method === 'POST') {
      try {
          const parsed = await parseBody(req);
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

          // 질환별 태스크 생성
          const topicTasks = targetTopics.map(function(topic) {
            return async function() {
              const topicResults = [];
              for (const model of models) {
                let mentionCount = 0;
                let citCount = 0;
                let totalQuestions = 0;
                let sampleAnswer = '';

                // 템플릿x반복 질문을 병렬로 실행
                const questionTasks = [];
                for (const template of templates) {
                  const question = template.replace(/\{disease\}/g, topic.name);
                  for (let r = 0; r < repeatCount; r++) {
                    questionTasks.push({ model: model, question: question });
                  }
                }

                const answers = await Promise.allSettled(
                  questionTasks.map(function(qt) { return askAIWithTimeout(qt.model, qt.question, citationSettings); })
                );

                for (let ai = 0; ai < answers.length; ai++) {
                  totalQuestions++;
                  if (answers[ai].status === 'fulfilled') {
                    var answer = answers[ai].value;
                    if (!sampleAnswer && answer.length > 0) sampleAnswer = answer.substring(0, 500);
                    var mentioned = answer.indexOf('화접몽') >= 0;
                    if (mentioned) {
                      mentionCount++;
                      var citMatches = answer.match(/화접몽/g);
                      citCount += citMatches ? citMatches.length : 0;
                    }
                  } else {
                    console.error('[인용추적] ' + model + ' 에러:', answers[ai].reason.message);
                    if (!sampleAnswer) sampleAnswer = 'ERROR: ' + answers[ai].reason.message;
                  }
                }

                var score = totalQuestions > 0 ? Math.round((mentionCount / totalQuestions) * 100) : 0;
                topicResults.push({
                  topic_id: topic.id,
                  topic_name: topic.name,
                  ai_model: model,
                  score: score,
                  mention_count: mentionCount,
                  citation_count: citCount,
                  total_questions: totalQuestions,
                  tracked_at: new Date().toISOString(),
                  _debug_sample: sampleAnswer,
                });
              }
              return topicResults;
            };
          });

          // 질환 2개씩 동시 처리
          const allResults = await runWithConcurrency(topicTasks, 2);
          for (let ri = 0; ri < allResults.length; ri++) {
            if (allResults[ri]) {
              for (let rj = 0; rj < allResults[ri].length; rj++) {
                trackingResults.push(allResults[ri][rj]);
              }
            }
          }

          if (trackingResults.length > 0) {
            var dbResults = trackingResults.map(function(r) {
              var copy = Object.assign({}, r);
              delete copy._debug_sample;
              return copy;
            });
            await citationResults.addBulk(dbResults);
          }

          jsonRes(res, { success: true, results: trackingResults, message: targetTopics.length + '개 질환 x ' + models.length + '개 AI 추적 완료' });
      } catch (e) {
        console.error('[인용추적] 오류:', e);
        jsonRes(res, { error: e.message }, 500);
      }
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

      // 질환별 인용 점수 집계
      var topicCitationStats = {};
      for (var tci = 0; tci < citations.length; tci++) {
        var tc2 = citations[tci];
        var tcKey = tc2.topic_name;
        if (!topicCitationStats[tcKey]) topicCitationStats[tcKey] = { scoreSum: 0, count: 0, mentionSum: 0, citSum: 0 };
        topicCitationStats[tcKey].scoreSum += Number(tc2.score || 0);
        topicCitationStats[tcKey].count++;
        topicCitationStats[tcKey].mentionSum += Number(tc2.mention_count || 0);
        topicCitationStats[tcKey].citSum += Number(tc2.citation_count || 0);
      }
      // 질환별 평균 점수 배열 (정렬)
      var topicCitationRanking = Object.keys(topicCitationStats).map(function(k) {
        var s = topicCitationStats[k];
        return { topic: k, avgScore: s.count > 0 ? Math.round(s.scoreSum / s.count) : 0, mentions: s.mentionSum, citations: s.citSum };
      }).sort(function(a, b) { return b.avgScore - a.avgScore; });

      // 인사이트 데이터 생성
      var insights = { topPerformers: [], needsImprovement: [], avgCitationScore: 0 };
      if (topicCitationRanking.length > 0) {
        insights.avgCitationScore = Math.round(topicCitationRanking.reduce(function(s, t) { return s + t.avgScore; }, 0) / topicCitationRanking.length);
        insights.topPerformers = topicCitationRanking.filter(function(t) { return t.avgScore >= 50; }).slice(0, 3);
        insights.needsImprovement = topicCitationRanking.filter(function(t) { return t.avgScore < 30; }).slice(0, 3);
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
        topicCitationRanking: topicCitationRanking,
        insights: insights,
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
    var gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiKey;
    var gResp = await fetch(gUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: question }] }], tools: [{ google_search: {} }] }),
    });
    var gData = await gResp.json();
    if (gData.error) {
      console.error('[Gemini API Error]', JSON.stringify(gData.error));
      return '';
    }
    // Grounding 응답은 parts가 여러 개일 수 있음 - 모든 text를 합침
    var allText = '';
    if (gData.candidates && gData.candidates[0] && gData.candidates[0].content && gData.candidates[0].content.parts) {
      var parts = gData.candidates[0].content.parts;
      for (var pi = 0; pi < parts.length; pi++) {
        if (parts[pi].text) allText += parts[pi].text;
      }
    }
    return allText;
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

// === Client Auth (1시간 만료 + 자동 정리) ===
var CLIENT_TOKENS = new Map();
var TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1시간

function genToken() {
  var t = ''; var ch = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (var i = 0; i < 32; i++) t += ch[Math.floor(Math.random() * ch.length)];
  return t;
}
function verifyToken(req) {
  var a = req.headers['authorization'];
  if (!a) return false;
  var tk = a.replace('Bearer ', '');
  var entry = CLIENT_TOKENS.get(tk);
  if (!entry) return false;
  if (Date.now() - new Date(entry.at).getTime() > TOKEN_EXPIRY_MS) {
    CLIENT_TOKENS.delete(tk);
    return false;
  }
  return true;
}
// 10분마다 만료 토큰 정리
setInterval(function() {
  var now = Date.now();
  CLIENT_TOKENS.forEach(function(val, key) {
    if (now - new Date(val.at).getTime() > TOKEN_EXPIRY_MS) CLIENT_TOKENS.delete(key);
  });
}, 10 * 60 * 1000);

function jsonRes(res, data, status) {
  status = status || 200;
  res.writeHead(status, { 'Content-Type': "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

server.listen(PORT, function() {
  console.log('[Server] 화접몽 GEO Auto-Publisher 실행 중 (Supabase DB)');
  console.log('[Server] 대시보드: http://localhost:' + PORT + '/dashboard');
  console.log('[Server] 광고주: http://localhost:' + PORT + '/client');
  console.log('[Server] API: http://localhost:' + PORT + '/api/status');
});
