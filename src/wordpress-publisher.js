/**
 * WordPress REST API (wp-json/wp/v2) 발행 모듈
 * Application Password 인증 (만료 없음)
 *
 * API 문서: https://developer.wordpress.org/rest-api/
 * 엔드포인트: https://{site}/wp-json/wp/v2/
 */

import { BRAND, WP_CATEGORIES, PUBLISH_CONFIG } from './config.js';

// ─── WP REST API 호출 헬퍼 (재시도 포함) ───
const WP_MAX_RETRIES = 3;
const WP_RETRY_DELAYS = [1000, 3000, 5000];

function getBasicAuth(env) {
  const user = env.WP_USERNAME || 'ozzy1993';
  const pass = env.WP_APP_PASSWORD || '';
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function getApiBase(env) {
  const site = env.WP_SITE_ID || 'mongclinic.blog';
  return `https://${site}/wp-json/wp/v2`;
}

async function wpApiCall(env, endpoint, method = 'GET', body = null, isFormData = false) {
  const apiBase = getApiBase(env);
  const auth = getBasicAuth(env);

  if (!env.WP_APP_PASSWORD) throw new Error('WP_APP_PASSWORD 환경변수가 설정되지 않았습니다');

  const url = `${apiBase}/${endpoint}`;
  const headers = {
    'Authorization': auth,
  };

  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  const options = { method, headers };

  if (body) {
    options.body = isFormData ? body : JSON.stringify(body);
  }

  let lastError;
  for (let attempt = 0; attempt < WP_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status >= 400 && response.status < 500) {
        const error = await response.text();
        throw new Error(`WordPress API error: ${response.status} - ${error}`);
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`WordPress API error: ${response.status} - ${error}`);
      }

      return response.json();
    } catch (e) {
      lastError = e;
      if (e.message && e.message.includes('API error: 4')) {
        throw e;
      }
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
    // 슬러그로 카테고리 검색
    const results = await wpApiCall(env, `categories?slug=${encodeURIComponent(categoryConfig.slug)}`);
    if (results && results.length > 0) return results[0].id;
  } catch (e) {
    // 없으면 생성 시도
  }

  try {
    const created = await wpApiCall(env, 'categories', 'POST', {
      name: categoryName,
      slug: categoryConfig.slug,
      description: categoryConfig.description,
    });
    return created.id;
  } catch (e) {
    console.error(`카테고리 생성 실패: ${categoryName}`, e.message);
    return null;
  }
}

// ─── 태그 가져오기 또는 생성 (WP REST API는 ID 배열 필요) ───
async function getOrCreateTags(env, tagNames) {
  if (!tagNames || tagNames.length === 0) return [];

  const tagIds = [];
  for (const name of tagNames) {
    try {
      // 기존 태그 검색
      const results = await wpApiCall(env, `tags?search=${encodeURIComponent(name)}&per_page=5`);
      const exact = results.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (exact) {
        tagIds.push(exact.id);
        continue;
      }
    } catch (e) {
      // 검색 실패 시 생성 시도
    }

    try {
      const created = await wpApiCall(env, 'tags', 'POST', { name });
      tagIds.push(created.id);
    } catch (e) {
      // 이미 존재하는 경우 (slug 충돌) 다시 검색
      try {
        const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9가-힣-]/g, '');
        const results = await wpApiCall(env, `tags?slug=${encodeURIComponent(slug)}`);
        if (results && results.length > 0) {
          tagIds.push(results[0].id);
        }
      } catch (e2) {
        console.error(`태그 생성/검색 실패: ${name}`, e2.message);
      }
    }
  }
  return tagIds;
}

// ─── 타임아웃 fetch 헬퍼 ───
const IMAGE_DOWNLOAD_TIMEOUT = 10000;
const IMAGE_UPLOAD_TIMEOUT = 30000;
const IMAGE_MAX_SIZE = 5 * 1024 * 1024;

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Hero 이미지 업로드 (WP REST API) ───
async function uploadHeroImage(env, imageData) {
  if (!imageData || !imageData.url) return null;

  try {
    const imageResponse = await fetchWithTimeout(imageData.url, {}, IMAGE_DOWNLOAD_TIMEOUT);
    if (!imageResponse.ok) return null;

    const imageBuffer = await imageResponse.arrayBuffer();

    if (imageBuffer.byteLength > IMAGE_MAX_SIZE) {
      console.warn(`[이미지 업로드] Hero 이미지 크기 초과 (${(imageBuffer.byteLength / 1024 / 1024).toFixed(1)}MB > 5MB) — 스킵`);
      return null;
    }

    const apiBase = getApiBase(env);
    const auth = getBasicAuth(env);
    const filename = `hwj-${Date.now()}.jpg`;

    const uploadResponse = await fetchWithTimeout(
      `${apiBase}/media`,
      {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': 'image/jpeg',
        },
        body: Buffer.from(imageBuffer),
      },
      IMAGE_UPLOAD_TIMEOUT
    );

    if (!uploadResponse.ok) {
      console.error('이미지 업로드 실패:', await uploadResponse.text());
      return null;
    }

    const media = await uploadResponse.json();
    return media.id || null;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('[이미지 업로드] Hero 이미지 타임아웃 — 스킵');
    } else {
      console.error('이미지 업로드 에러:', e.message);
    }
    return null;
  }
}

// ─── 단일 이미지를 WordPress에 업로드하고 URL 반환 ───
async function uploadImageToWP(env, imageUrl, filename) {
  try {
    console.log(`[이미지 업로드] 다운로드 시작: ${imageUrl.substring(0, 100)}`);
    const imageResponse = await fetchWithTimeout(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HWJBot/1.0)' },
      redirect: 'follow',
    }, IMAGE_DOWNLOAD_TIMEOUT);
    if (!imageResponse.ok) {
      console.error(`[이미지 업로드] 다운로드 실패: HTTP ${imageResponse.status} — ${imageUrl.substring(0, 80)}`);
      return null;
    }

    const imageBuffer = await imageResponse.arrayBuffer();

    if (imageBuffer.byteLength > IMAGE_MAX_SIZE) {
      console.warn(`[이미지 업로드] 크기 초과 (${(imageBuffer.byteLength / 1024 / 1024).toFixed(1)}MB > 5MB) — 스킵: ${imageUrl.substring(0, 80)}`);
      return null;
    }

    const apiBase = getApiBase(env);
    const auth = getBasicAuth(env);
    const fname = filename || `hwj-${Date.now()}.jpg`;

    const uploadResponse = await fetchWithTimeout(
      `${apiBase}/media`,
      {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Disposition': `attachment; filename="${fname}"`,
          'Content-Type': 'image/jpeg',
        },
        body: Buffer.from(imageBuffer),
      },
      IMAGE_UPLOAD_TIMEOUT
    );

    if (!uploadResponse.ok) {
      console.error('[이미지 업로드] 실패:', uploadResponse.status);
      return null;
    }

    const media = await uploadResponse.json();
    const wpUrl = media.source_url || media.guid?.rendered || '';
    console.log(`[이미지 업로드] 성공: ${wpUrl}`);
    return { id: media.id, url: wpUrl };
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error(`[이미지 업로드] 다운로드 타임아웃 — 스킵: ${imageUrl.substring(0, 80)}`);
    } else {
      console.error('[이미지 업로드] 에러:', e.message);
    }
    return null;
  }
}

// ─── 본문 내 외부 이미지를 WordPress로 업로드 후 URL 교체 ───
async function uploadInlineImages(env, htmlContent) {
  const imgRegex = /<img\s[^>]*?src="(https?:\/\/[^"]+)"[^>]*>/gi;
  let match;
  const replacements = [];

  while ((match = imgRegex.exec(htmlContent)) !== null) {
    const url = match[1];
    if (url.includes('wordpress.com') || url.includes('wp.com') || url.includes('mongclinic.blog')) continue;
    replacements.push({ fullMatch: match[0], originalUrl: url });
  }

  if (replacements.length === 0) {
    console.log('[이미지 업로드] 교체할 외부 이미지 없음');
    return htmlContent;
  }

  const MAX_INLINE_IMAGES = 10;
  if (replacements.length > MAX_INLINE_IMAGES) {
    console.warn(`[이미지 업로드] 외부 이미지 ${replacements.length}개 중 ${MAX_INLINE_IMAGES}개만 처리`);
    replacements.length = MAX_INLINE_IMAGES;
  }

  console.log(`[이미지 업로드] 본문 내 외부 이미지 ${replacements.length}개 처리 시작`);

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

  // 2. 태그 준비 (WP REST API는 ID 배열 필요)
  const tagIds = await getOrCreateTags(env, content.tags || []);

  // 3. Hero 이미지 업로드
  const featuredImageId = await uploadHeroImage(env, content.heroImage);

  // 3.5. 본문 내 외부 이미지를 WordPress 미디어 라이브러리로 업로드 후 URL 교체
  const processedContent = await uploadInlineImages(env, content.content);

  // 4. 글 발행 (WP REST API v2)
  const postData = {
    title: content.title,
    content: processedContent,
    excerpt: content.excerpt,
    slug: content.slug,
    status: statusOverride || PUBLISH_CONFIG.defaultStatus,
    categories: categoryId ? [categoryId] : [],
    tags: tagIds,
    featured_media: featuredImageId || 0,
    meta: {
      _yoast_wpseo_title: content.title,
      _yoast_wpseo_metadesc: content.metaDescription || '',
    },
  };

  const post = await wpApiCall(env, 'posts', 'POST', postData);

  console.log(`[WordPress] 발행 완료: ${post.link} (ID: ${post.id}, Status: ${post.status})`);

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: typeof post.title === 'object' ? post.title.rendered : post.title,
    publishedAt: post.date,
  };
}

// ─── WordPress 게시글 수정 ───
export async function updateWordPressPost(env, wpPostId, updates) {
  console.log(`[WordPress] 게시글 수정 시작: ID ${wpPostId}`);

  let processedContent = updates.content;
  if (processedContent) {
    processedContent = await uploadInlineImages(env, processedContent);
  }

  const postData = {};
  if (updates.title) postData.title = updates.title;
  if (processedContent) postData.content = processedContent;
  if (updates.excerpt) postData.excerpt = updates.excerpt;
  if (updates.tags) {
    const tagNames = Array.isArray(updates.tags) ? updates.tags : updates.tags.split(',');
    postData.tags = await getOrCreateTags(env, tagNames);
  }
  if (updates.metaDescription) {
    postData.meta = {
      _yoast_wpseo_title: updates.title || '',
      _yoast_wpseo_metadesc: updates.metaDescription,
    };
  }

  const post = await wpApiCall(env, `posts/${wpPostId}`, 'POST', postData);
  console.log(`[WordPress] 게시글 수정 완료: ${post.link} (ID: ${post.id})`);

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: typeof post.title === 'object' ? post.title.rendered : post.title,
  };
}

// ─── 최근 발행 목록 조회 ───
export async function getRecentPosts(env, count = 10) {
  try {
    const results = await wpApiCall(env, `posts?per_page=${count}&orderby=date&order=desc`);
    return results.map((p) => ({
      id: p.id,
      title: typeof p.title === 'object' ? p.title.rendered : p.title,
      link: p.link,
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
    const site = env.WP_SITE_ID || 'mongclinic.blog';

    if (!env.WP_APP_PASSWORD) return { connected: false, error: 'WP_APP_PASSWORD 미설정' };

    const auth = getBasicAuth(env);
    const response = await fetch(`https://${site}/wp-json/wp/v2/users/me`, {
      headers: { 'Authorization': auth },
    });

    if (!response.ok) {
      return { connected: false, error: `HTTP ${response.status}` };
    }

    const user = await response.json();
    return {
      connected: true,
      siteName: user.name || 'Unknown',
      siteUrl: `https://${site}`,
    };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}
