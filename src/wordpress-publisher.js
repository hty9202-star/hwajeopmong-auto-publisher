/**
 * WordPress.com REST API v1.1 발행 모듈
 * WordPress.com 호스팅형 전용 (OAuth2 Bearer 토큰 인증)
 *
 * API 문서: https://developer.wordpress.com/docs/api/
 * 엔드포인트: https://public-api.wordpress.com/rest/v1.1/sites/{site}/
 */

import { BRAND, WP_CATEGORIES, PUBLISH_CONFIG } from './config.js';

const WP_API_BASE = 'https://public-api.wordpress.com/rest/v1.1';

// ─── WordPress.com API 호출 헬퍼 (재시도 포함) ───
const WP_MAX_RETRIES = 3;
const WP_RETRY_DELAYS = [1000, 3000, 5000]; // 1초, 3초, 5초 대기

async function wpApiCall(env, endpoint, method = 'GET', body = null) {
  const siteId = env.WP_SITE_ID || 'mongclinictest.wordpress.com';
  const token = env.WP_ACCESS_TOKEN;

  if (!token) throw new Error('WP_ACCESS_TOKEN 환경변수가 설정되지 않았습니다');

  const url = `${WP_API_BASE}/sites/${siteId}/${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  let lastError;
  for (let attempt = 0; attempt < WP_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      // 4xx 클라이언트 에러는 재시도해도 의미 없음 (401 토큰만료, 400 잘못된 요청 등)
      if (response.status >= 400 && response.status < 500) {
        const error = await response.text();
        throw new Error(`WordPress.com API error: ${response.status} - ${error}`);
      }

      // 5xx 서버 에러 또는 네트워크 문제는 재시도
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`WordPress.com API error: ${response.status} - ${error}`);
      }

      return response.json();
    } catch (e) {
      lastError = e;
      // 4xx 에러는 즉시 throw (재시도 불필요)
      if (e.message && e.message.includes('API error: 4')) {
        throw e;
      }
      // 마지막 시도가 아니면 대기 후 재시도
      if (attempt < WP_MAX_RETRIES - 1) {
        const delay = WP_RETRY_DELAYS[attempt] || 5000;
        console.log(`[WordPress] 재시도 ${attempt + 1}/${WP_MAX_RETRIES - 1} (${delay}ms 후): ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── 카테고리 가져오기 또는 생성 ───
async function getOrCreateCategory(env, categoryName) {
  const categoryConfig = WP_CATEGORIES[categoryName];
  if (!categoryConfig) return null;

  try {
    // 기존 카테고리 검색
    const result = await wpApiCall(env, `categories/slug:${categoryConfig.slug}`);
    if (result && result.ID) return result.ID;
  } catch (e) {
    // 없으면 생성
  }

  try {
    const created = await wpApiCall(env, 'categories/new', 'POST', {
      name: categoryName,
      description: categoryConfig.description,
    });
    return created.ID;
  } catch (e) {
    console.error(`카테고리 생성 실패: ${categoryName}`, e.message);
    return null;
  }
}

// ─── 태그 문자열 준비 (WordPress.com은 태그를 쉼표 구분 문자열로 받음) ───
function prepareTags(tagNames) {
  return tagNames.join(',');
}

// ─── Hero 이미지 업로드 ───
async function uploadHeroImage(env, imageData) {
  if (!imageData || !imageData.url) return null;

  try {
    // 이미지 다운로드
    const imageResponse = await fetch(imageData.url);
    if (!imageResponse.ok) return null;

    const imageBuffer = await imageResponse.arrayBuffer();
    const siteId = env.WP_SITE_ID || 'mongclinictest.wordpress.com';
    const token = env.WP_ACCESS_TOKEN;

    // WordPress.com 미디어 업로드
    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
    formData.append('media[]', blob, `hwj-${Date.now()}.jpg`);

    const uploadResponse = await fetch(
      `${WP_API_BASE}/sites/${siteId}/media/new`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      }
    );

    if (!uploadResponse.ok) {
      console.error('이미지 업로드 실패:', await uploadResponse.text());
      return null;
    }

    const media = await uploadResponse.json();
    if (media.media && media.media.length > 0) {
      return media.media[0].ID;
    }
    return null;
  } catch (e) {
    console.error('이미지 업로드 에러:', e.message);
    return null;
  }
}

// ─── 단일 이미지를 WordPress에 업로드하고 URL 반환 ───
async function uploadImageToWP(env, imageUrl, filename) {
  try {
    console.log(`[이미지 업로드] 다운로드 시작: ${imageUrl.substring(0, 100)}`);
    const imageResponse = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HWJBot/1.0)' },
      redirect: 'follow',
    });
    if (!imageResponse.ok) {
      console.error(`[이미지 업로드] 다운로드 실패: HTTP ${imageResponse.status} — ${imageUrl.substring(0, 80)}`);
      return null;
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const siteId = env.WP_SITE_ID || 'mongclinictest.wordpress.com';
    const token = env.WP_ACCESS_TOKEN;

    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
    formData.append('media[]', blob, filename || `hwj-${Date.now()}.jpg`);

    const uploadResponse = await fetch(
      `${WP_API_BASE}/sites/${siteId}/media/new`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      }
    );

    if (!uploadResponse.ok) {
      console.error('[이미지 업로드] 실패:', uploadResponse.status);
      return null;
    }

    const media = await uploadResponse.json();
    if (media.media && media.media.length > 0) {
      const wpUrl = media.media[0].URL || media.media[0].link;
      console.log(`[이미지 업로드] 성공: ${wpUrl}`);
      return { id: media.media[0].ID, url: wpUrl };
    }
    return null;
  } catch (e) {
    console.error('[이미지 업로드] 에러:', e.message);
    return null;
  }
}

// ─── 본문 내 외부 이미지를 WordPress로 업로드 후 URL 교체 ───
async function uploadInlineImages(env, htmlContent) {
  // 본문에서 모든 외부 이미지 URL 추출 (WordPress 자체 호스팅 URL 제외)
  const imgRegex = /<img\s[^>]*?src="(https?:\/\/[^"]+)"[^>]*>/gi;
  let match;
  const replacements = [];

  while ((match = imgRegex.exec(htmlContent)) !== null) {
    const url = match[1];
    // WordPress 자체 호스팅 URL은 스킵
    if (url.includes('wordpress.com') || url.includes('wp.com')) continue;
    replacements.push({ fullMatch: match[0], originalUrl: url });
  }

  if (replacements.length === 0) {
    console.log('[이미지 업로드] 교체할 외부 이미지 없음');
    return htmlContent;
  }

  console.log(`[이미지 업로드] 본문 내 외부 이미지 ${replacements.length}개 발견`);

  for (let i = 0; i < replacements.length; i++) {
    const r = replacements[i];
    console.log(`[이미지 업로드] ${i + 1}/${replacements.length} 시도: ${r.originalUrl.substring(0, 80)}...`);
    const result = await uploadImageToWP(env, r.originalUrl, `hwj-inline-${Date.now()}-${i}.jpg`);
    if (result && result.url) {
      htmlContent = htmlContent.replaceAll(r.originalUrl, result.url);
      console.log(`[이미지 업로드] ${i + 1}/${replacements.length} 교체 완료 → ${result.url}`);
    } else {
      console.log(`[이미지 업로드] ${i + 1}/${replacements.length} 실패 — 원본 URL 유지`);
    }
  }

  return htmlContent;
}

// ─── 메인 발행 함수 ───
export async function publishToWordPress(env, content, statusOverride) {
  console.log(`[WordPress] 발행 시작: ${content.title}`);

  // 1. 카테고리 준비
  const categoryId = await getOrCreateCategory(env, content.category);

  // 2. 태그 준비 (WordPress.com은 쉼표 구분 문자열)
  const tags = prepareTags(content.tags || []);

  // 3. Hero 이미지 업로드
  const featuredImageId = await uploadHeroImage(env, content.heroImage);

  // 3.5. 본문 내 외부 이미지를 WordPress 미디어 라이브러리로 업로드 후 URL 교체
  const processedContent = await uploadInlineImages(env, content.content);

  // 4. 글 발행 (WordPress.com REST API v1.1)
  const postData = {
    title: content.title,
    content: processedContent,
    excerpt: content.excerpt,
    slug: content.slug,
    status: statusOverride || PUBLISH_CONFIG.defaultStatus, // 승인 시 'publish', 기본은 'draft'
    categories: content.category,          // WordPress.com은 이름으로 지정 가능
    tags: tags,
    featured_image: featuredImageId || undefined,
    // SEO 메타 (Jetpack SEO가 활성화된 경우)
    metadata: [
      { key: '_yoast_wpseo_title', value: content.title },
      { key: '_yoast_wpseo_metadesc', value: content.metaDescription },
    ],
  };

  const post = await wpApiCall(env, 'posts/new', 'POST', postData);

  console.log(`[WordPress] 발행 완료: ${post.URL} (ID: ${post.ID}, Status: ${post.status})`);

  return {
    id: post.ID,
    link: post.URL,
    status: post.status,
    title: post.title,
    publishedAt: post.date,
  };
}

// ─── 최근 발행 목록 조회 ───
export async function getRecentPosts(env, count = 10) {
  try {
    const result = await wpApiCall(env, `posts?number=${count}&order_by=date&order=DESC`);
    return (result.posts || []).map((p) => ({
      id: p.ID,
      title: p.title,
      link: p.URL,
      status: p.status,
      date: p.date,
      slug: p.slug,
    }));
  } catch (e) {
    console.error('최근 글 조회 실패:', e.message);
    return [];
  }
}

// ─── WordPress 연결 상태 확인 ───
export async function checkConnection(env) {
  try {
    const siteId = env.WP_SITE_ID || 'mongclinictest.wordpress.com';
    const token = env.WP_ACCESS_TOKEN;

    if (!token) return { connected: false, error: 'WP_ACCESS_TOKEN 미설정' };

    const response = await fetch(`${WP_API_BASE}/sites/${siteId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      return { connected: false, error: `HTTP ${response.status}` };
    }

    const site = await response.json();
    return {
      connected: true,
      siteName: site.name || 'Unknown',
      siteUrl: site.URL || `https://${siteId}`,
    };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

// ─── OAuth 토큰 갱신 안내 ───
// WordPress.com OAuth 토큰은 14일 후 만료됩니다.
// 갱신 방법: 아래 URL을 브라우저에서 다시 방문하여 새 토큰을 발급받으세요.
// https://public-api.wordpress.com/oauth2/authorize?client_id=137509&redirect_uri=https://example.com&response_type=token
// 발급된 토큰을 WP_ACC