/**
 * 자동 발행 로직 + Cron 스케줄링
 */
import cron from 'node-cron';
import { CONTENT_TYPES, TOPICS } from '../config.js';
import { generateContent, injectInternalLinks } from '../content-generator.js';
import { publishToWordPress } from '../wordpress-publisher.js';
import { contentQueue, publishLogs, publishedTopics, settings, topics as topicsDB } from '../supabase-client.js';
import { env } from './env.js';
import { saveErrorLog } from './helpers.js';

// ─── 발행 모드에 따른 다음 토픽 선택 (공용) ───
export async function resolveNextTopic(allTopics) {
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

// ─── 자동 발행 로직 ───
let isPublishing = false;

export function getIsPublishing() { return isPublishing; }

export async function autoPublish(options) {
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

  // ── 2-2단계: 목표 콘텐츠 수 도달 체크 ──
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

  // ── 4.5단계: 본문 맥락 내부 링크 자동 삽입 (발행된 연관 질환 글로) ──
  try {
    // DB 토픽에는 relatedTopics가 없을 수 있으므로 config(TOPICS)에서 보완 (id=슬러그 매칭)
    var relatedTopics = topic.relatedTopics;
    if ((!relatedTopics || !relatedTopics.length) && topic.id) {
      var cfgTopic = TOPICS.find(function(t) { return t.id === topic.id; });
      if (cfgTopic && cfgTopic.relatedTopics) relatedTopics = cfgTopic.relatedTopics;
    }
    if (relatedTopics && relatedTopics.length) {
      const allItems = await contentQueue.getAll();
      const publishedMap = {};
      for (var pi = 0; pi < allItems.length; pi++) {
        var it = allItems[pi];
        var url = it.wp_post_url || it.wordpress_url || it.post_url;
        if (url && !it.is_test && (it.status === 'published' || it.status === 'approved') && it.topic_id) {
          if (!publishedMap[it.topic_id]) {
            publishedMap[it.topic_id] = { name: it.topic_name, url: url };
          }
        }
      }
      var linkedCount = Object.keys(publishedMap).length;
      if (linkedCount > 0) {
        var topicForLinks = (topic.relatedTopics && topic.relatedTopics.length)
          ? topic
          : Object.assign({}, topic, { relatedTopics: relatedTopics });
        result.content = injectInternalLinks(result.content, topicForLinks, publishedMap, 3);
        console.log('[내부링크] 발행 글 ' + linkedCount + '건 기준으로 본문 링크 주입 완료 (relatedTopics: ' + relatedTopics.join(',') + ')');
      }
    }
  } catch (e) {
    console.error('[내부링크] 주입 실패(발행은 계속):', e.message);
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
export const FREQUENCY_PRESETS = {
  '1': ['0 9 * * *'],
  '2': ['0 9 * * *', '0 15 * * *'],
  '3': ['0 9 * * *', '0 13 * * *', '0 17 * * *'],
  '5': ['0 9 * * *', '0 11 * * *', '0 13 * * *', '0 15 * * *', '0 17 * * *'],
};
export const FREQUENCY_LABELS = {
  '1': '09:00 (1회/일)',
  '2': '09:00, 15:00 (2회/일)',
  '3': '09:00, 13:00, 17:00 (3회/일)',
  '5': '09:00, 11:00, 13:00, 15:00, 17:00 (5회/일)',
};

export let activeCronJobs = [];
export let schedulerEnabled = true;

export async function setupCronSchedule() {
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

export function setSchedulerEnabled(val) { schedulerEnabled = val; }
export function getSchedulerEnabled() { return schedulerEnabled; }

// ─── 다음 발행 예정 시간 계산 (KST 문자열 반환) ───
export async function getNextPublishTime() {
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

  const publishStartDate = publishSettings.startDate;
  const publishEndDate = publishSettings.endDate;
  const todayStr = kstNow.getUTCFullYear() + '-' + String(kstNow.getUTCMonth()+1).padStart(2,'0') + '-' + String(kstNow.getUTCDate()).padStart(2,'0');

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

// ─── DB에 저장된 이미지 API 키를 환경변수에 병합 ───
export async function loadImageApiKeys() {
  try {
    const imgSettings = await settings.get('imageApis');
    if (imgSettings) {
      if (imgSettings.pixabayApiKey && !env.PIXABAY_API_KEY) env.PIXABAY_API_KEY = imgSettings.pixabayApiKey;
      if (imgSettings.unsplashAccessKey && !env.UNSPLASH_ACCESS_KEY) env.UNSPLASH_ACCESS_KEY = imgSettings.unsplashAccessKey;
      if (imgSettings.pexelsApiKey && !env.PEXELS_API_KEY) env.PEXELS_API_KEY = imgSettings.pexelsApiKey;
      console.log('[Server] DB 이미지 API 키 로드 완료');
    }
  } catch (e) { console.error('[Server] 이미지 API 키 로드 실패:', e.message); }
}
