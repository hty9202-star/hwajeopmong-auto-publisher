/**
 * 인용추적 API 라우트 핸들러
 * server.js에서 분리된 모듈
 */
import { settings, topics as topicsDB, citationResults } from '../supabase-client.js';
import { env } from '../lib/env.js';
import { jsonRes, parseBody, saveErrorLog, runWithConcurrency } from '../lib/helpers.js';
import { askAI, askAIWithTimeout, askAIWithRetry, runQuestionsSequentially, setupCitationCron } from '../lib/citation.js';

/**
 * 인용추적 API 라우트 처리
 * @param {object} req - HTTP 요청
 * @param {object} res - HTTP 응답
 * @param {string} pathname - URL 경로
 * @param {string} method - HTTP 메서드
 * @param {URL} url - URL 객체
 * @returns {boolean} true if handled, false otherwise
 */
export async function handleCitationRoutes(req, res, pathname, method, url) {

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
    jsonRes(res, citResult);
    return true;
  }

  // POST: 인용추적 설정 저장
  if (pathname === '/api/citation-settings' && method === 'POST') {
    try {
      const data = await parseBody(req);
      await settings.set('citation', data);
      await setupCitationCron();
      jsonRes(res, { success: true });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return true;
  }

  // GET: 인용추적 결과 조회
  if (pathname === '/api/citation-results' && method === 'GET') {
    try {
      const results = await citationResults.getRecent(100);
      jsonRes(res, results || []);
      return true;
    } catch (e) {
      console.error('[Citation Results] 에러:', e.message);
      jsonRes(res, { error: e.message }, 500);
      return true;
    }
  }

  // POST: API 키 연결 테스트
  if (pathname === '/api/citation-test-key' && method === 'POST') {
    try {
      const parsed = await parseBody(req);
      var testModel = parsed.model;
      var testKey = parsed.apiKey;
      if (!testModel || !testKey) { jsonRes(res, { success: false, error: 'model과 apiKey 필수' }, 400); return true; }

      var testQuestion = '안녕하세요, 연결 테스트입니다. 짧게 답변해주세요.';
      if (testModel === 'chatgpt') {
        var tResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + testKey },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: testQuestion }], max_tokens: 50 }),
        });
        var tData = await tResp.json();
        if (tData.error) { jsonRes(res, { success: false, error: tData.error.message || 'API 키 오류' }); return true; }
        jsonRes(res, { success: true, model: 'ChatGPT' }); return true;
      } else if (testModel === 'claude') {
        var clResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': testKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 50, messages: [{ role: 'user', content: testQuestion }] }),
        });
        var clData = await clResp.json();
        if (clData.error) { jsonRes(res, { success: false, error: clData.error.message || 'API 키 오류' }); return true; }
        jsonRes(res, { success: true, model: 'Claude' }); return true;
      } else if (testModel === 'gemini') {
        var gKey = env.GEMINI_API_KEY;
        if (!gKey) { jsonRes(res, { success: false, error: 'Gemini API 키 미설정 (서버 환경변수)' }); return true; }
        var gResp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + gKey, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: testQuestion }] }] }),
        });
        var gData = await gResp.json();
        if (gData.error) { jsonRes(res, { success: false, error: gData.error.message || 'API 키 오류' }); return true; }
        jsonRes(res, { success: true, model: 'Gemini' }); return true;
      }
      jsonRes(res, { success: false, error: '알 수 없는 모델: ' + testModel }, 400); return true;
    } catch (e) {
      jsonRes(res, { success: false, error: e.message || '연결 실패' }); return true;
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
        if (!geminiKey) { jsonRes(res, { success: false, error: 'Gemini API key not set' }); return true; }
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
        if (!chatKey) { jsonRes(res, { success: false, error: 'ChatGPT API key not set in citation settings' }); return true; }
        var cResp = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
          body: JSON.stringify({
            model: 'gpt-5.4', // 운영(lib/citation.js)과 동일 모델 — 디버그 결과가 실제와 일치하도록
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
        if (!clKey) { jsonRes(res, { success: false, error: 'Claude API key not set in citation settings' }); return true; }
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

      jsonRes(res, {
        success: true,
        model: debugModel,
        question: debugQuestion,
        parsedText: parsedText.substring(0, 2000),
        contains화접몽: contains화접몽,
        rawResponseKeys: rawResponse ? Object.keys(rawResponse) : null,
        rawResponsePreview: rawResponse ? JSON.stringify(rawResponse).substring(0, 3000) : null,
      });
      return true;
    } catch (e) {
      console.error('[인용디버그] 오류:', e);
      jsonRes(res, { success: false, error: e.message });
      return true;
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

              // Claude는 순차 호출 (rate limit 방지), 나머지는 병렬
              const answers = (model === 'claude')
                ? await runQuestionsSequentially(questionTasks, citationSettings, 3000)
                : await Promise.allSettled(
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

        // Claude 포함 시 토픽 동시 처리 1개로 제한 (rate limit 방지)
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
    return true;
  }

  // 이 핸들러가 처리하지 않는 라우트
  return false;
}
