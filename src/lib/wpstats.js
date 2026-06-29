/**
 * WordPress.com (Jetpack) 통계 조회
 * 월간 리포트용 조회수(views)·방문자수(visitors)를 가져온다.
 *
 * 필요 env:
 *   WP_COM_STATS_TOKEN  — WordPress.com OAuth 읽기 토큰 (scope: stats)
 *   WP_SITE_ID          — 사이트 식별자 (기본: mongclinic.blog)
 *
 * 토큰이 없으면 null을 반환해 리포트는 트래픽 없이 정상 동작한다.
 */
export async function getWpComTraffic(startDate, endDate) {
  const token = process.env.WP_COM_STATS_TOKEN;
  const site = process.env.WP_SITE_ID || 'mongclinic.blog';
  if (!token) return null;

  try {
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    if (isNaN(start) || isNaN(end)) return null;
    const days = Math.max(1, Math.round((end - start) / 86400000) + 1);

    const url = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(site)}/stats/visits` +
      `?unit=day&date=${encodeURIComponent(endDate)}&quantity=${days}&fields=views,visitors`;

    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      console.warn('[WPStats] 통계 조회 실패:', r.status, (await r.text()).slice(0, 120));
      return null;
    }
    const j = await r.json();
    const fields = j.fields || [];
    const vi = fields.indexOf('views');
    const ui = fields.indexOf('visitors');
    let views = 0, visitors = 0;
    (j.data || []).forEach(function (row) {
      if (vi >= 0) views += Number(row[vi] || 0);
      if (ui >= 0) visitors += Number(row[ui] || 0);
    });
    return { views: views, visitors: visitors, days: days };
  } catch (e) {
    console.warn('[WPStats] 예외:', e.message);
    return null;
  }
}
