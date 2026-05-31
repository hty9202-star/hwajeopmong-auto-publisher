/**
 * AI 인용추적 로직 (askAI + 자동 cron)
 */
import cron from 'node-cron';
import { settings, topics as topicsDB, citationResults } from '../supabase-client.js';
import { env } from './env.js';
import { saveErrorLog, runWithConcurrency } from './helpers.js';

// ─── AI 인용추적용 API 호출 ───
export async function askAI(model, question, citationSettings) {
  citationSettings = citationSettings || {};

  if (model === 'gemini') {
    var geminiKey = env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error('Gemini API key not set');
    var gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiKey;
    var gResp = await fetch(gUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: question }] }], tools: [{ google_search: {} }] }),
      signal: AbortSignal.timeout(30000),
    });
    var gData = await gResp.json();
    if (gData.error) {
      console.error('[Gemini API Error]', JSON.stringify(gData.error));
      return '';
    }
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
      signal: AbortSignal.timeout(30000),
    });
    var cData = await cResp.json();
    if (cData.error) {
      console.error('[ChatGPT API Error]', JSON.stringify(cData.error));
      return '';
    }
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
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: question + '\n\n반드시 웹 검색을 수행하고, 검색 결과에서 찾은 실제 존재하는 한의원/병원의 정확한 이름을 포함하여 추천해주세요.' }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    var clData = await clResp.json();
    if (clData.error) {
      console.error('[Claude API Error]', JSON.stringify(clData.error));
      if (clData.error.type === 'rate_limit_error' || (clData.error.message && clData.error.message.indexOf('rate') >= 0)) {
        throw new Error('rate_limit: ' + (clData.error.message || clData.error.type));
      }
      return '';
    }
    var clTexts = [];
    if (clData.content && Array.isArray(clData.content)) {
      for (var cli = 0; cli < clData.content.length; cli++) {
        if (clData.content[cli].type === 'text' && clData.content[cli].text) {
          clTexts.push(clData.content[cli].text);
        }
      }
    }
    var clResult = clTexts.join('\n');
    if (clResult.length > 0) console.log('[Claude] 응답 길이=' + clResult.length + ', 화접몽포함=' + (clResult.indexOf('화접몽') >= 0));
    else console.warn('[Claude] 빈 응답, keys:', Object.keys(clData).join(','));
    return clResult;
  }

  throw new Error('Unknown AI model: ' + model);
}

// AI 호출 타임아웃 래퍼
export function askAIWithTimeout(model, question, s) {
  var timeout = model === 'claude' ? 60000 : 30000;
  return Promise.race([
    askAIWithRetry(model, question, s),
    new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout ' + (timeout/1000) + 's')); }, timeout); })
  ]);
}

// rate limit 재시도 래퍼 (Claude용, 최대 2회 재시도)
export async function askAIWithRetry(model, question, s, retries) {
  if (retries === undefined) retries = 2;
  try {
    return await askAI(model, question, s);
  } catch (e) {
    if (retries > 0 && e.message && e.message.indexOf('rate_limit') >= 0) {
      var delay = (3 - retries) * 5000 + 3000;
      console.log('[' + model + '] rate limit, ' + delay + 'ms 대기 후 재시도 (남은=' + retries + ')');
      await new Promise(function(r) { setTimeout(r, delay); });
      return askAIWithRetry(model, question, s, retries - 1);
    }
    throw e;
  }
}

// Claude/ChatGPT 순차 실행 헬퍼
export async function runQuestionsSequentially(questionTasks, citationSettings, delayMs) {
  if (!delayMs) delayMs = 2000;
  var results = [];
  for (var i = 0; i < questionTasks.length; i++) {
    if (i > 0) await new Promise(function(r) { setTimeout(r, delayMs); });
    try {
      var answer = await askAIWithTimeout(questionTasks[i].model, questionTasks[i].question, citationSettings);
      results.push({ status: 'fulfilled', value: answer });
    } catch (e) {
      results.push({ status: 'rejected', reason: e });
    }
  }
  return results;
}

// ─── 인용추적 자동 cron ───
export let citationCronJob = null;
export let lastCitationTrackTime = null;

export const CITATION_CRON_MAP = {
  'daily': '0 6 * * *',
  'weekly': '0 6 * * 1',
  'biweekly': '0 6 1,15 * *',
  'monthly': '0 6 1 * *',
};

export async function autoTrackCitations() {
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
          let mentionCount = 0, citCount = 0, validCount = 0, failCount = 0, sampleAnswer = '';
          const questionTasks = [];
          for (const template of templates) {
            const question = template.replace(/\{disease\}/g, topic.name);
            for (let r = 0; r < repeatCount; r++) {
              questionTasks.push({ model: model, question: question });
            }
          }
          const answers = (model === 'claude')
            ? await runQuestionsSequentially(questionTasks, citationSettings, 3000)
            : await Promise.allSettled(
                questionTasks.map(function(qt) { return askAIWithTimeout(qt.model, qt.question, citationSettings); })
              );
          for (let ai = 0; ai < answers.length; ai++) {
            // 유효 응답만 집계: API 실패(rejected)나 빈 응답('')은 "측정 실패"로 보고 제외.
            // rate limit·timeout으로 실패한 호출이 0점으로 저장되어 데이터를 왜곡하는 문제 방지.
            if (answers[ai].status === 'fulfilled' && answers[ai].value && answers[ai].value.length > 0) {
              var answer = answers[ai].value;
              validCount++;
              if (!sampleAnswer) sampleAnswer = answer.substring(0, 500);
              if (answer.indexOf('화접몽') >= 0) {
                mentionCount++;
                var citMatches = answer.match(/화접몽/g);
                citCount += citMatches ? citMatches.length : 0;
              }
            } else {
              failCount++;
              var failReason = answers[ai].status === 'rejected' ? answers[ai].reason.message : '빈 응답';
              console.error('[인용추적 자동] ' + model + ' 에러:', failReason);
            }
          }
          // 유효 응답이 하나도 없으면(전부 rate limit·timeout 실패) 저장하지 않고 건너뛴다.
          // → 측정 실패가 "0점"으로 기록되어 평균·추세를 왜곡하는 것을 막는다.
          if (validCount === 0) {
            console.warn('[인용추적 자동] ' + topic.name + '/' + model + ' 유효 응답 0건(전부 실패) → 저장 건너뜀 (실패 ' + failCount + '건)');
            continue;
          }
          // 점수는 "유효 응답"만 분모로 계산 (부분 실패가 점수를 희석하지 않도록).
          var score = Math.round((mentionCount / validCount) * 100);
          topicResults.push({
            topic_id: topic.id, topic_name: topic.name, ai_model: model,
            score: score, mention_count: mentionCount, citation_count: citCount,
            total_questions: validCount, tracked_at: new Date().toISOString(),
          });
        }
        return topicResults;
      };
    });

    const concurrency = models.includes('claude') ? 1 : 2;
    const allResults = await runWithConcurrency(topicTasks, concurrency);
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

export async function setupCitationCron() {
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
