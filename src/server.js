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
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { CONTENT_TYPES, BRAND } from './config.js';
import { generateContent, calculateGeoScore, calculateEeatScore } from './content-generator.js';
import { publishToWordPress, updateWordPressPost, getRecentPosts, checkConnection } from './wordpress-publisher.js';
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

// 공용 body 파싱 유틸 (최대 1MB 제한)
const MAX_BODY_SIZE = 1 * 1024 * 1024;
function parseBody(req) {
  return new Promise(function(resolve, reject) {
    let body = '';
    let size = 0;
    req.on('data', function(ch) {
      size += ch.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('요청 크기 초과 (최대 1MB)'));
        return;
      }
      body += ch;
    });
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
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinic.blog',
  WP_AUTH_KEY: process.env.WP_AUTH_KEY,
  PIXABAY_API_KEY: process.env.PIXABAY_API_KEY,
  UNSPLASH_ACCESS_KEY: process.env.UNSPLASH_ACCESS_KEY,
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

  // 개별 질환/유형 지정
  const manualTopic = publish.nextTopic && !['auto','random','balanced','sequential'].includes(publish.nextTopic);
  const manualCT = publish.nextContentType && publish.nextContentType !== 'auto';
  if (manualTopic || manualCT) {
    const selectedTopic = manualTopic ? allTopics.find(function(t) { return t.id === publish.nextTopic; }) : allTopics[topicIdx % allTopics.length];
    const selectedCT = manualCT ? (CONTENT_TYPES.find(function(ct) { return ct.id === publish.nextContentType; }) || CONTENT_TYPES[ctIdx % CONTENT_TYPES.length]) : CONTENT_TYPES[ctIdx % CONTENT_TYPES.length];
    if (selectedTopic) return { topic: selectedTopic, contentType: selectedCT, mode: 'manual' };
  }

  if (publishMode === 'random') {
    const randTopicIdx = Math.floor(Math.random() * allTopics.length);
    const randCtIdx = Math.floor(Math.random() * CONTENT_TYPES.length);
    return { topic: allTopics[randTopicIdx], contentType: CONTENT_TYPES[randCtIdx], mode: 'random' };
  }
  if (publishMode === 'balanced') {
    const topicCounts = {};
    for (const t of allTopics) topicCounts[t.id] = 0;
    // 발행 기간이 설정된 경우 기간 내 콘텐츠만 카운트
    let queueItems;
    if (publish.startDate) {
      const periodEnd = publish.endDate || '2099-12-31';
      queueItems = await contentQueue.getByDateRange(publish.startDate, periodEnd);
    } else {
      queueItems = await contentQueue.getAll();
    }
    for (const item of (queueItems || [])) {
      if (!item.is_test && topicCounts[item.topic_id] !== undefined) topicCounts[item.topic_id]++;
    }
    const sorted = [...allTopics].sort(function(a, b) { return (topicCounts[a.id] || 0) - (topicCounts[b.id] || 0); });
    return { topic: sorted[0], contentType: CONTENT_TYPES[ctIdx % CONTENT_TYPES.length], mode: 'balanced' };
  }
  // auto / sequential
  return { topic: allTopics[topicIdx % allTopics.length], contentType: CONTENT_TYPES[ctIdx % CONTENT_TYPES.length], mode: publishMode };
}

// ─── 에러 로그 저장 헬퍼 ───
async function saveErrorLog(source, error) {
  try {
    const existing = await settings.get('error_logs');
    const logs = Array.isArray(existing) ? existing : [];
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    logs.unshift({
      timestamp: kst.toISOString(),
      source: source,
      message: error.message || String(error),
      stack: error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : '',
    });
    // 최근 100건만 유지
    if (logs.length > 100) logs.length = 100;
    await settings.set('error_logs', logs);
  } catch (logErr) {
    console.error('에러 로그 저장 실패:', logErr);
  }
}

// ─── 자동 발행 로직 ───
let isPublishing = false;

async function autoPublish(options) {
  if (isPublishing) {
    console.log('[발행] 이미 발행 진행 중 — 중복 실행 방지됨');
    return { skipped: true, reason: '이미 발행 진행 중' };
  }
  isPublishing = true;
  try {
    return await _doAutoPublish(options);
  } finally {
    isPublishing = false;
  }
}

async function _doAutoPublish(options) {
  var opts = options || {};
  var isTest = opts.isTest || false;
  var bypassPeriodCheck = opts.bypassPeriodCheck || false;
  var forceTopic = opts.forceTopic || null;
  var forceContentType = opts.forceContentType || null;
  var republishedFrom = opts.republishedFrom || null;

  // ── 1단계: 초기 검증 ──
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.log('No GEMINI_API_KEY'); return; }

  var allTopics, publish, publishMode;
  try {
    allTopics = await topicsDB.getAll();
    if (!allTopics || allTopics.length === 0) { console.log('No active topics'); return; }
    publish = await settings.get('publish') || {};
    publishMode = publish.publishMode || 'auto';
  } catch (e) {
    console.error('[autoPublish] 초기 설정 로드 실패:', e);
    await saveErrorLog('autoPublish_초기설정', e);
    return;
  }

  // ── 2단계: 발행 기간 체크 ──
  if (!isTest && !bypassPeriodCheck) {
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
    console.log(bypassPeriodCheck ? '[재발행] 기간 체크 건너뜀' : '[테스트 발행] 기간 체크 건너뜀');
  }

  // ── 2-2단계: 목표 콘텐츠 수 도달 체크 (기간 내 콘텐츠만 카운트) ──
  if (!isTest && !bypassPeriodCheck && publish.totalTarget) {
    let periodCreatedCount = 0;
    if (publish.startDate) {
      const periodEnd = publish.endDate || '2099-12-31';
      const periodQueue = await contentQueue.getByDateRange(publish.startDate, periodEnd);
      periodCreatedCount = (periodQueue || []).filter(function(item) {
        return item.status !== 'rejected' && !item.is_test;
      }).length;
    } else {
      const counts = await contentQueue.getCounts();
      periodCreatedCount = counts.total;
    }
    if (periodCreatedCount >= publish.totalTarget) {
      console.log('[목표 도달] 기간 내 ' + periodCreatedCount + '/' + publish.totalTarget + '건 생성 완료. 발행 건너뜀.');
      return;
    }
  }

  // ── 3단계: 토픽 선택 ──
  var topic, contentType;
  try {
    if (forceTopic && forceContentType) {
      topic = forceTopic;
      contentType = forceContentType;
      console.log('[재발행] 같은 주제로 재생성: ' + topic.name + ' / ' + contentType.name);
    } else {
      const next = await resolveNextTopic(allTopics);
      if (!next) { console.log('No topic resolved'); return; }
      topic = next.topic;
      contentType = next.contentType;
    }
  } catch (e) {
    console.error('[autoPublish] 토픽 선택 실패:', e);
    await saveErrorLog('autoPublish_토픽선택', e);
    return;
  }

  // ── 4단계: 콘텐츠 생성 ──
  var result;
  try {
    console.log('Generating: ' + topic.name + ' / ' + contentType.name);
    const comboId = topic.id + '__' + contentType.id;
    const existingTitles = await contentQueue.getTitlesByComboId(comboId);
    if (existingTitles.length > 0) {
      console.log('[중복 방지] 기존 ' + existingTitles.length + '건 제목 회피: ' + existingTitles.join(', '));
    }
    const imagesPerContent = publish.imagesPerContent || 3;
    result = await generateContent(env, topic, contentType, { existingTitles, imagesPerContent });
    if (!result || !result.content) {
      console.log('[autoPublish] 콘텐츠 생성 결과 없음');
      return;
    }
  } catch (e) {
    console.error('[autoPublish] 콘텐츠 생성 실패:', e);
    await saveErrorLog('autoPublish_콘텐츠생성', e);
    return;
  }

  // ── 5단계: DB 저장 ──
  var queueId;
  try {
    const comboId = topic.id + '__' + contentType.id;
    const review = result.review || { total: 0, high: 0, medium: 0, status: 'clean' };
    if (review.total > 0) {
      console.log('[검수 완료] ' + review.total + '건 자동 치환 (의료법: ' + review.high + ', 과장광고: ' + review.medium + ')');
    }

    const geo = result.geoScore || { score: 0, details: {} };
    const eeat = result.eeatScore || { score: 0, details: {} };
    if (geo.score || eeat.score) {
      console.log('[품질] GEO: ' + geo.score + '/100, E-E-A-T: ' + eeat.score + '/100');
    }

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
      category: topic.name || result.category || '피부질환',
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
      is_test: isTest,
      republished_from: republishedFrom || null,
    });

    queueId = (inserted && inserted[0] && inserted[0].id) ? inserted[0].id : null;
    console.log((isTest ? '[테스트] ' : (republishedFrom ? '[재발행] ' : '')) + 'Queued: ' + result.title + ' (ID: ' + queueId + ')');
  } catch (e) {
    console.error('[autoPublish] DB 저장 실패:', e);
    await saveErrorLog('autoPublish_DB저장', e);
    return;
  }

  // ── 6단계: 발행 로그 기록 ──
  try {
    const comboId = topic.id + '__' + contentType.id;
    await publishLogs.add({
      queue_id: queueId,
      combo_id: comboId,
      topic_name: topic.name,
      content_type_name: contentType.name,
      title: result.title,
      status: 'queued',
      is_test: isTest,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[autoPublish] 발행 로그 기록 실패:', e);
    await saveErrorLog('autoPublish_로그기록', e);
    // 로그 실패는 치명적이지 않으므로 계속 진행
  }

  // ── 7단계: 인덱스 업데이트 ──
  try {
    if (!isTest) {
      const idxData = await settings.get('topicIndex');
      let topicIdx = idxData ? parseInt(idxData) : 0;
      const ctIdxData = await settings.get('contentTypeIndex');
      let ctIdx = ctIdxData ? parseInt(ctIdxData) : 0;

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

      // 개별 질환/유형 지정이었으면 리셋
      var needReset = false;
      if (publish.nextTopic && !['auto','random','balanced','sequential'].includes(publish.nextTopic)) {
        publish.nextTopic = 'auto';
        needReset = true;
      }
      if (publish.nextContentType && publish.nextContentType !== 'auto') {
        publish.nextContentType = 'auto';
        needReset = true;
      }
      if (needReset) await settings.set('publish', publish);
    } else {
      console.log('[테스트 발행] 인덱스 업데이트 건너뜀');
    }
  } catch (e) {
    console.error('[autoPublish] 인덱스 업데이트 실패:', e);
    await saveErrorLog('autoPublish_인덱스', e);
  }
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
    const job = cron.schedule(finalExpr, function() {
      autoPublish().catch(function(err) {
        console.error('[Cron] autoPublish 예외:', err);
        saveErrorLog('cron_autoPublish', err).catch(function() {});
      });
    }, { timezone: 'Asia/Seoul' });
    activeCronJobs.push(job);
  });

  const daysLabel = days === 'weekdays' ? '평일만' : '매일';
  console.log('[Server] Cron 스케줄 등록: ' + daysLabel + ' ' + (FREQUENCY_LABELS[frequency] || FREQUENCY_LABELS['5']));
}

setupCronSchedule().catch(function(e) { console.error('[Server] cron 스케줄 초기화 실패:', e.message); });

// ─── DB에 저장된 이미지 API 키를 환경변수에 병합 ───
(async function loadImageApiKeys() {
  try {
    const imgSettings = await settings.get('imageApis');
    if (imgSettings) {
      if (imgSettings.pixabayApiKey && !env.PIXABAY_API_KEY) env.PIXABAY_API_KEY = imgSettings.pixabayApiKey;
      if (imgSettings.unsplashAccessKey && !env.UNSPLASH_ACCESS_KEY) env.UNSPLASH_ACCESS_KEY = imgSettings.unsplashAccessKey;
      if (imgSettings.pexelsApiKey && !env.PEXELS_API_KEY) env.PEXELS_API_KEY = imgSettings.pexelsApiKey;
      console.log('[Server] DB 이미지 API 키 로드 완료');
    }
  } catch (e) { console.error('[Server] 이미지 API 키 로드 실패:', e.message); }
})().catch(function(e) { console.error('[Server] 이미지 API 키 IIFE 예외:', e.message); });

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
    await saveErrorLog('인용추적_자동', e);
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
  citationCronJob = cron.schedule(cronExpr, function() {
    autoTrackCitations().catch(function(err) {
      console.error('[Cron] 인용추적 예외:', err);
      saveErrorLog('cron_citation', err).catch(function() {});
    });
  }, { timezone: 'Asia/Seoul' });
  citationCronJob._freq = freq;
  console.log('[Server] 인용추적 cron 등록: ' + freq + ' (' + cronExpr + ')');
}

setupCitationCron().catch(function(e) { console.error('[Server] 인용추적 cron 초기화 실패:', e.message); });

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
    // Admin login page
    if (pathname === '/admin/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getHtml('admin-login.html'));
    }

    // Admin login API
    if (pathname === '/api/admin/login' && method === 'POST') {
      try {
        const parsed = await parseBody(req);
        const adminId = process.env.ADMIN_ID || 'admin';
        const adminPw = process.env.ADMIN_PASSWORD || '123456';
        if (parsed.id === adminId && parsed.password === adminPw) {
          const tk = genToken();
          ADMIN_TOKENS.set(tk, { id: parsed.id, at: new Date().toISOString() });
          jsonRes(res, { success: true, token: tk });
        } else {
          jsonRes(res, { success: false, error: '아이디 또는 비밀번호가 일치하지 않습니다' }, 401);
        }
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
      return;
    }

    // Admin token verify API
    if (pathname === '/api/admin/verify' && method === 'GET') {
      jsonRes(res, { valid: verifyAdminToken(req) });
      return;
    }

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

    // === Admin API 인증 체크 (클라이언트 API 제외) ===
    var isAdminApi = pathname.startsWith('/api/') && !pathname.startsWith('/api/admin/') && !pathname.startsWith('/api/client/');
    if (isAdminApi && !verifyAdminToken(req)) {
      return jsonRes(res, { error: '인증이 필요합니다' }, 401);
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

      return jsonRes(res, {
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
    }

    // API: Topics (DB 기반)
    if (pathname === '/api/topics' && method === 'GET') {
      const publishedComboIds = await publishedTopics.getComboIds();
      const allTopics = await topicsDB.getAll();
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

    // API: Errors (GET: 조회, DELETE: 전체 삭제)
    if (pathname === '/api/errors' && method === 'GET') {
      const errorData = await settings.get('error_logs');
      return jsonRes(res, errorData || []);
    }
    if (pathname === '/api/error-logs' && method === 'DELETE') {
      await settings.set('error_logs', []);
      console.log('[Server] 에러 로그 전체 삭제');
      return jsonRes(res, { success: true });
    }

    // API: Publish Now - 1회 테스트 발행 (POST)
    if (pathname === '/api/publish-now' && method === 'POST') {
      if (isPublishing) {
        return jsonRes(res, { message: '이미 발행이 진행 중입니다. 완료 후 다시 시도해주세요.' }, 409);
      }
      const allTopicsForPublish = await topicsDB.getAll();
      const next = await resolveNextTopic(allTopicsForPublish);

      autoPublish({ isTest: true }).catch(function(e) { saveErrorLog('테스트발행', e); });

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
      const defaultPublish = { publishFrequency: '5', publishDays: 'everyday', publishMode: 'auto', totalTarget: 50, nextTopic: 'auto', nextContentType: 'auto', imagesPerContent: 3 };
      var publishMerged = {};
      Object.keys(defaultPublish).forEach(function(k) { publishMerged[k] = defaultPublish[k]; });
      Object.keys(publishData).forEach(function(k) { publishMerged[k] = publishData[k]; });

      const allTopics = await topicsDB.getAll();
      const topicsList = (allTopics || []).map(function(t) {
        return { id: t.id, name: t.name, category: t.category, keywords: t.keywords || [] };
      });
      const ctList = CONTENT_TYPES.map(function(ct) { return { id: ct.id, name: ct.name }; });
      return jsonRes(res, { publish: publishMerged, topics: topicsList, contentTypes: ctList });
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

    // --- Client API: Status (인증 불필요 — 광고주 대시보드용) ---
    if (pathname === '/api/client/status' && method === 'GET') {
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

        return jsonRes(res, {
          content: { published: periodPublished, totalTarget: totalTarget },
          nextPublishTime: nextPublishTime,
          publishPeriod: publishPeriod,
        });
      } catch (e) {
        console.error('[Client Status] 에러:', e.message);
        return jsonRes(res, { error: e.message }, 500);
      }
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
      return;
    }

    // --- Client API: Retry WP publish (wp_failed → 재시도) ---
    if (pathname.match(/^\/api\/client\/contents\/[^/]+\/retry$/) && method === 'POST') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = pathname.split('/')[4];
      const item = await contentQueue.getById(itemId);
      if (!item || item.status !== 'wp_failed') { jsonRes(res, { error: 'Not found or not retryable' }, 404); return; }

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
      return;
    }

    // --- Client/Admin API: Edit (승인된 콘텐츠 수정) ---
    if (pathname.match(/^\/api\/client\/contents\/[^/]+\/edit$/) && method === 'POST') {
      if (!verifyToken(req)) { jsonRes(res, { error: 'Unauthorized' }, 401); return; }
      const itemId = pathname.split('/')[4];
      const item = await contentQueue.getById(itemId);
      if (!item) { jsonRes(res, { error: 'Not found' }, 404); return; }

      const editData = await parseBody(req).catch(function() { return {}; });
      if (!editData.title && !editData.content) {
        jsonRes(res, { error: '수정할 내용이 없습니다' }, 400);
        return;
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
        const updatedContent = editData.content || item.content;
        const updatedTitle = editData.title || item.title;
        const updatedMetaDesc = editData.meta_description || item.meta_description || '';
        try {
          const geoResult = calculateGeoScore(updatedContent, updatedTitle, updatedMetaDesc, item.faq || [], item.schemas || null);
          const eeatResult = calculateEeatScore(updatedContent, updatedTitle);
          dbUpdates.geo_score = geoResult.total;
          dbUpdates.geo_detail = geoResult;
          dbUpdates.eeat_score = eeatResult.total;
          dbUpdates.eeat_detail = eeatResult;
          console.log(`[수정 API] 품질 점수 재계산: GEO ${geoResult.total}, E-E-A-T ${eeatResult.total}`);
        } catch (scoreErr) {
          console.error('[수정 API] 점수 재계산 실패 (무시):', scoreErr.message);
        }

        await contentQueue.updateContent(itemId, dbUpdates);

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
        console.error('[수정 API] 에러:', e.message);
        jsonRes(res, { error: e.message }, 500);
      }
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

    // === 이미지 API 설정 ===

    if (pathname === '/api/image-settings' && method === 'GET') {
      const imgSettings = await settings.get('imageApis') || {};
      return jsonRes(res, {
        pixabayApiKey: imgSettings.pixabayApiKey || '',
        unsplashAccessKey: imgSettings.unsplashAccessKey || '',
        pexelsApiKey: imgSettings.pexelsApiKey || '',
      });
    }

    if (pathname === '/api/image-settings' && method === 'POST') {
      try {
        const data = await parseBody(req);
        await settings.set('imageApis', data);
        // 환경변수에도 반영 (런타임)
        if (data.pixabayApiKey) env.PIXABAY_API_KEY = data.pixabayApiKey;
        if (data.unsplashAccessKey) env.UNSPLASH_ACCESS_KEY = data.unsplashAccessKey;
        if (data.pexelsApiKey) env.PEXELS_API_KEY = data.pexelsApiKey;
        return jsonRes(res, { success: true });
      } catch (e) { return jsonRes(res, { error: e.message }, 400); }
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

    // POST: API 키 연결 테스트
    if (pathname === '/api/citation-test-key' && method === 'POST') {
      try {
        const parsed = await parseBody(req);
        var testModel = parsed.model;
        var testKey = parsed.apiKey;
        if (!testModel || !testKey) return jsonRes(res, { success: false, error: 'model과 apiKey 필수' }, 400);

        var testQuestion = '안녕하세요, 연결 테스트입니다. 짧게 답변해주세요.';
        if (testModel === 'chatgpt') {
          var tResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + testKey },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: testQuestion }], max_tokens: 50 }),
          });
          var tData = await tResp.json();
          if (tData.error) return jsonRes(res, { success: false, error: tData.error.message || 'API 키 오류' });
          return jsonRes(res, { success: true, model: 'ChatGPT' });
        } else if (testModel === 'claude') {
          var clResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': testKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 50, messages: [{ role: 'user', content: testQuestion }] }),
          });
          var clData = await clResp.json();
          if (clData.error) return jsonRes(res, { success: false, error: clData.error.message || 'API 키 오류' });
          return jsonRes(res, { success: true, model: 'Claude' });
        } else if (testModel === 'gemini') {
          var gKey = env.GEMINI_API_KEY;
          if (!gKey) return jsonRes(res, { success: false, error: 'Gemini API 키 미설정 (서버 환경변수)' });
          var gResp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + gKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: testQuestion }] }] }),
          });
          var gData = await gResp.json();
          if (gData.error) return jsonRes(res, { success: false, error: gData.error.message || 'API 키 오류' });
          return jsonRes(res, { success: true, model: 'Gemini' });
        }
        return jsonRes(res, { success: false, error: '알 수 없는 모델: ' + testModel }, 400);
      } catch (e) {
        return jsonRes(res, { success: false, error: e.message || '연결 실패' });
      }
    }

    // POST: 인용추적 디버그 — 단일 질문으로 raw 응답 확인
    if (pathname === '/api/citation-debug' && method === 'POST') {
      try {
        const parsed = await parseBody(req);
        var debugModel = parsed.model || 'gemini';
        var debugQuestion = parsed.question || '디스크 치료 잘하는 한의원 추천해줘';
        const citationSettings = await settings.get('citation') || {};

        console.log('[인용디버그] model=' + debugModel + ', question=' + debugQuestion);

        var rawResponse = null;
        var parsedText = '';
        var error = null;

        if (debugModel === 'gemini') {
          var geminiKey = env.GEMINI_API_KEY;
          if (!geminiKey) return jsonRes(res, { success: false, error: 'Gemini API key not set' });
          var gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiKey;
          var gResp = await fetch(gUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: debugQuestion }] }], tools: [{ google_search: {} }] }),
          });
          rawResponse = await gResp.json();
          // parse same way as askAI
          if (rawResponse.candidates && rawResponse.candidates[0] && rawResponse.candidates[0].content && rawResponse.candidates[0].content.parts) {
            var parts = rawResponse.candidates[0].content.parts;
            for (var pi = 0; pi < parts.length; pi++) {
              if (parts[pi].text) parsedText += parts[pi].text;
            }
          }
        } else if (debugModel === 'chatgpt') {
          var chatKey = citationSettings.chatgptApiKey;
          if (!chatKey) return jsonRes(res, { success: false, error: 'ChatGPT API key not set in citation settings' });
          var cResp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
            body: JSON.stringify({
              model: 'gpt-4o',
              tools: [{
                type: 'web_search',
                search_context_size: 'high',
                user_location: {
                  type: 'approximate',
                  country: 'KR',
                  city: 'Seoul',
                  region: 'Gangnam',
                  timezone: 'Asia/Seoul',
                },
              }],
              tool_choice: 'required',
              input: debugQuestion,
              instructions: '반드시 웹 검색을 수행하고, 검색 결과에서 찾은 실제 존재하는 한의원/병원의 정확한 이름을 포함하여 추천해주세요. 일반적인 조언이 아닌, 구체적인 업체명과 위치 정보를 답변에 반드시 포함하세요.',
            }),
          });
          rawResponse = await cResp.json();
          // parse same way as askAI
          if (rawResponse.output && Array.isArray(rawResponse.output)) {
            var texts = [];
            for (var oi = 0; oi < rawResponse.output.length; oi++) {
              var item = rawResponse.output[oi];
              if (item.type === 'message' && item.content) {
                for (var ci = 0; ci < item.content.length; ci++) {
                  if (item.content[ci].type === 'output_text') texts.push(item.content[ci].text);
                }
              }
            }
            parsedText = texts.join('\n');
          }
        } else if (debugModel === 'claude') {
          var clKey = citationSettings.claudeApiKey;
          if (!clKey) return jsonRes(res, { success: false, error: 'Claude API key not set in citation settings' });
          var clResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': clKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: debugQuestion }] }),
          });
          rawResponse = await clResp.json();
          parsedText = (rawResponse.content && rawResponse.content[0] && rawResponse.content[0].text) || '';
        }

        var contains화접몽 = parsedText.indexOf('화접몽') >= 0;
        console.log('[인용디버그] 결과: contains화접몽=' + contains화접몽 + ', parsedText길이=' + parsedText.length);

        return jsonRes(res, {
          success: true,
          model: debugModel,
          question: debugQuestion,
          parsedText: parsedText.substring(0, 2000),
          contains화접몽: contains화접몽,
          rawResponseKeys: rawResponse ? Object.keys(rawResponse) : null,
          rawResponsePreview: rawResponse ? JSON.stringify(rawResponse).substring(0, 3000) : null,
        });
      } catch (e) {
        console.error('[인용디버그] 오류:', e);
        return jsonRes(res, { success: false, error: e.message });
      }
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
        await saveErrorLog('인용추적_수동', e);
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
      var logs = (await publishLogs.getByDateRange(rStartDate, rEndDate) || []).filter(function(l) { return !l.is_test; });
      var queue = (await contentQueue.getByDateRange(rStartDate, rEndDate) || []).filter(function(q) { return !q.is_test; });
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
        await saveErrorLog('월간리포트', reportErr);
        return jsonRes(res, { error: reportErr.message }, 500);
      }
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    console.error('Server error:', error);
    await saveErrorLog('서버오류', error);
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
    if (allText.length > 0) console.log('[Gemini] 응답 길이=' + allText.length + ', 화접몽포함=' + (allText.indexOf('화접몽') >= 0));
    else console.warn('[Gemini] 빈 응답, candidates:', JSON.stringify(gData.candidates || gData.error || {}).substring(0, 300));
    return allText;
  }

  if (model === 'chatgpt') {
    var chatKey = citationSettings.chatgptApiKey;
    if (!chatKey) throw new Error('ChatGPT API key not set');
    // web_search (신규 표준) + user_location(서울 강남) + tool_choice required로 검색 강제
    // web_search는 레거시이며 필터/위치 등 고급 기능 미지원
    var cResp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
      body: JSON.stringify({
        model: 'gpt-4o',
      tools: [{
          type: 'web_search',
          search_context_size: 'high',
          user_location: {
            type: 'approximate',
            country: 'KR',
            city: 'Seoul',
            region: 'Gangnam',
            timezone: 'Asia/Seoul',
          },
        }],
        tool_choice: 'required',
        input: question,
        instructions: '반드시 웹 검색을 수행하고, 검색 결과에서 찾은 실제 존재하는 한의원/병원의 정확한 이름을 포함하여 추천해주세요. 일반적인 조언이 아닌, 구체적인 업체명과 위치 정보를 답변에 반드시 포함하세요.',
      }),
    });
    var cData = await cResp.json();
    if (cData.error) {
      console.error('[ChatGPT API Error]', JSON.stringify(cData.error));
      return '';
    }
    // Extract text from Responses API output array
    if (cData.output && Array.isArray(cData.output)) {
      var texts = [];
      var didSearch = false;
      for (var oi = 0; oi < cData.output.length; oi++) {
        var item = cData.output[oi];
        if (item.type === 'web_search_call') didSearch = true;
        if (item.type === 'message' && item.content) {
          for (var ci = 0; ci < item.content.length; ci++) {
            if (item.content[ci].type === 'output_text') texts.push(item.content[ci].text);
          }
        }
      }
      if (!didSearch) console.warn('[ChatGPT] 웹 검색이 수행되지 않았음: ' + question.substring(0, 50));
      var result = texts.join('\n');
      if (result.length > 0) console.log('[ChatGPT] 응답 길이=' + result.length + ', 화접몽포함=' + (result.indexOf('화접몽') >= 0));
      return result;
    }
    console.warn('[ChatGPT] output 배열 없음, 응답 키:', Object.keys(cData).join(','));
    return '';
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

// === Admin Auth ===
var ADMIN_TOKENS = new Map();

function verifyAdminToken(req) {
  var a = req.headers['authorization'];
  if (!a) return false;
  var tk = a.replace('Bearer ', '');
  var entry = ADMIN_TOKENS.get(tk);
  if (!entry) return false;
  if (Date.now() - new Date(entry.at).getTime() > TOKEN_EXPIRY_MS) {
    ADMIN_TOKENS.delete(tk);
    return false;
  }
  return true;
}

// === Client Auth (1시간 만료 + 자동 정리) ===
var CLIENT_TOKENS = new Map();
var TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1시간    
function genToken() {
  try { return crypto.randomBytes(24).toString('hex'); }
  catch(e) { var t='';var ch='abcdefghijklmnopqrstuvwxyz0123456789';for(var i=0;i<48;i++)t+=ch[Math.floor(Math.random()*ch.length)];return t; }
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
  ADMIN_TOKENS.forEach(function(val, key) {
    if (now - new Date(val.at).getTime() > TOKEN_EXPIRY_MS) ADMIN_TOKENS.delete(key);
  });
}, 10 * 60 * 1000);

function jsonRes(res, data, status) {
  status = status || 200;
  res.writeHead(status, { 'Content-Type': "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// ─── 전역 예외 핸들러 (프로세스 종료 방지) ───
process.on('unhandledRejection', function(reason) {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  saveErrorLog('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))).catch(function() {});
});

process.on('uncaughtException', function(err) {
  console.error('[FATAL] Uncaught Exception:', err);
  saveErrorLog('uncaughtException', err).catch(function() {});
  // uncaughtException은 프로세스를 종료하는 것이 권장되지만,
  // Render.com이 자동 재시작하므로 로그만 남기고 종료
  setTimeout(function() { process.exit(1); }, 1000);
});

server.listen(PORT, function() {
  console.log('[Server] 화접몹 GEO Auto-Publisher 실행 중 (Supabase DB)');
  console.log('[Server] 대시보드: http://localhost:' + PORT + '/dashboard');
  console.log('[Server] 광고주: http://localhost:' + PORT + '/client');
  console.log('[Server] API: http://localhost:' + PORT + '/api/status');
});
