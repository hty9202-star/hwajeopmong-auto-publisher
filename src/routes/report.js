/**
 * 월간 리포트 API 라우트 핸들러
 * server.js에서 분리된 모듈
 */
import { publishLogs, contentQueue, citationResults } from '../supabase-client.js';
import { jsonRes, saveErrorLog } from '../lib/helpers.js';

/**
 * 월간 리포트 API 라우트 처리
 * @param {object} req - HTTP 요청
 * @param {object} res - HTTP 응답
 * @param {string} pathname - URL 경로
 * @param {string} method - HTTP 메서드
 * @param {URL} url - URL 객체
 * @returns {boolean} true if handled, false otherwise
 */
export async function handleReportRoutes(req, res, pathname, method, url) {
  if (pathname === '/api/report' && method === 'GET') {
    var rStartDate = url.searchParams.get('startDate');
    var rEndDate = url.searchParams.get('endDate');
    if (!rStartDate || !rEndDate) {
      jsonRes(res, { error: 'startDate, endDate 필수' }, 400); return true;
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

      jsonRes(res, {
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
      return true;
    } catch (reportErr) {
      console.error('Report API error:', reportErr);
      await saveErrorLog('월간리포트', reportErr);
      jsonRes(res, { error: reportErr.message }, 500);
      return true;
    }
  }

  return false;
}
