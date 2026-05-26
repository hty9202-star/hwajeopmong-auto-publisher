/**
 * WordPress Bridge API 발행 모듈
 * Hwajeopmong WP Bridge 플러그인 사용 (X-WP-Auth-Key 인증)
 *
 * 엔드포인트: https://{site}/wp-json/hwj-bridge/v1/
 */

import { BRAND, WP_CATEGORIES, PUBLISH_CONFIG } from './config.js';

// ─── Bridge API 호출 헬퍼 (재시도 포함) ───
const WP_MAX_RETRIES = 3;
const WP_RETRY_DELAYS = [1000, 3000, 5000];

function getBridgeBase(env) {
  const site = env.WP_SITE_ID || 'mongclinic.blog';
  return `https://${site}/wp-json/hwj-bridge/v1`;
}

function getAuthHeaders(env) {
  const authKey = env.WP_AUTH_KEY || '';
  return {
    'X-WP-Auth-Key': authKey,
    'Content-Type': 'application/json',
  };
}

async function bridgeApiCall(env, endpoint, method = 'GET', body = null) {
  const base = getBridgeBase(env);
  const authKey = env.WP_AUTH_KEY;

  if (!authKey) throw new Error('WP_AUTH_KEY 환경변수가 설정되지 않았습니다');

  const url = `${base}/${endpoint}`;
  const headers = getAuthHeaders(env);
  const options = { method, headers };

  if (body) {
    options.body = JSON.stringify(body);
  }

  let lastError;
  for (let attempt = 0; attempt < WP_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status >= 400 && response.status < 500) {
        const error = await response.text();
        throw new Error(`WordPress Bridge API error: ${response.status} - ${error}`);
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`WordPress Bridge API error: ${response.status} - ${error}`);
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

// ─── WP REST API 직접 호출 (카테고리 전용) ───
async function wpRestCall(env, endpoint, method = 'GET', body = null) {
  const site = env.WP_SITE_ID || 'mongclinic.blog';
  const url = `https://${site}/wp-json/wp/v2/${endpoint}`;
  const authKey = env.WP_AUTH_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (authKey) headers['Authorization'] = 'Basic ' + Buffer.from(authKey).toString('base64');
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`WP REST ${method} ${endpoint}: ${resp.status}`);
  return resp.json();
}

// ─── 카테고리 ID 조회 또는 생성 ───
const categoryCache = new Map();

async function resolveCategory(env, categoryName) {
  if (!categoryName) return null;

  if (categoryCache.has(categoryName)) {
    return categoryCache.get(categoryName);
  }

  const slug = WP_CATEGORIES[categoryName]
    ? WP_CATEGORIES[categoryName].slug
    : categoryName.toLowerCase().replace(/\s+/g, '-');

  try {
    try {
      const categories = await bridgeApiCall(env, 'categories', 'GET');
      if (Array.isArray(categories)) {
        const found = categories.find(c => c.name === categoryName || c.slug === slug);
        if (found) {
          console.log(`[WordPress] 카테고리 발견 (Bridge): "${categoryName}" → ID ${found.id}`);
          categoryCache.set(categoryName, found.id);
          return found.id;
        }
      }
    } catch (bridgeErr) {
      console.log(`[WordPress] Bridge 카테고리 API 미지원, WP REST API 시도: ${bridgeErr.message}`);
    }

    try {
      const cats = await wpRestCall(env, `categories?search=${encodeURIComponent(categoryName)}&per_page=50`);
      if (Array.isArray(cats)) {
        const found = cats.find(c => c.name === categoryName || c.slug === slug);
        if (found) {
          console.log(`[WordPress] 카테고리 발견 (REST): "${categoryName}" → ID ${found.id}`);
          categoryCache.set(categoryName, found.id);
          return found.id;
        }
      }
    } catch (restErr) {
      console.log(`[WordPress] REST 카테고리 검색 실패: ${restErr.message}`);
    }

    const createData = {
      name: categoryName,
      slug: slug,
      description: WP_CATEGORIES[categoryName]?.description || `${categoryName} 관련 콘텐츠`,
    };

    let created;
    try {
      created = await bridgeApiCall(env, 'categories', 'POST', createData);
    } catch (e) {
      created = await wpRestCall(env, 'categories', 'POST', createData);
    }
    console.log(`[WordPress] 카테고리 생성: "${categoryName}" → ID ${created.id}`);
    categoryCache.set(categoryName, created.id);
    return created.id;
  } catch (e) {
    console.error(`[WordPress] 카테고리 처리 실패 (${categoryName}):`, e.message);
    return categoryName;
  }
}

// ─── Hero 이미지 업로드 (Bridge media 엔드포인트 사용) ───
async function uploadHeroImage(env, imageData) {
  if (!imageData || !imageData.url) return null;

  try {
    console.log(`[이미지 업로드] Hero 이미지 Bridge 업로드: ${imageData.url.substring(0, 80)}`);
    const result = await bridgeApiCall(env, 'media', 'POST', {
      url: imageData.url,
    });
    return result.id || null;
  } catch (e) {
    console.error('이미지 업로드 에러:', e.message);
    return null;
  }
}

// ─── 단일 이미지를 Bridge를 통해 WordPress에 업로드 ───
async function uploadImageToWP(env, imageUrl) {
  try {
    console.log(`[이미지 업로드] Bridge 업로드: ${imageUrl.substring(0, 80)}`);
    const result = await bridgeApiCall(env, 'media', 'POST', { url: imageUrl });
    console.log(`[이미지 업로드] 성공: ${result.url}`);
    return { id: result.id, url: result.url };
  } catch (e) {
    console.error('[이미지 업로드] 에러:', e.message);
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
    const result = await uploadImageToWP(env, r.originalUrl);
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
  console.log(`[WordPress] 발행 시작 (Bridge API): ${content.title}`);

  // 1. 본문 내 외부 이미지를 WordPress 미디어 라이브러리로 업로드 후 URL 교체
  const processedContent = await uploadInlineImages(env, content.content);

  // 2. 카테고리 ID 조회 또는 생성
  const categoryId = await resolveCategory(env, content.category);

  // 3. 글 발행 (Bridge API)
  const meta = {
    _yoast_wpseo_title: content.title,
    _yoast_wpseo_metadesc: content.metaDescription || '',
  };

  // JSON-LD 스키마를 커스텀 메타 필드로 전달
  if (content.schemas && Array.isArray(content.schemas) && content.schemas.length > 0) {
    meta._hwj_jsonld = JSON.stringify(content.schemas);
  }

  // 3-1. Hero 이미지를 미디어 라이브러리에 업로드 → featured_media ID 확보
  let featuredMediaId = null;
  if (content.heroImage && content.heroImage.url) {
    featuredMediaId = await uploadHeroImage(env, content.heroImage);
    if (featuredMediaId) {
      console.log(`[WordPress] 대표 이미지 설정: media ID ${featuredMediaId}`);
    } else {
      console.log(`[WordPress] 대표 이미지 업로드 실패 — featured_image_url로 폴백`);
    }
  }

  const postData = {
    title: content.title,
    content: processedContent,
    excerpt: content.excerpt,
    slug: content.slug,
    status: statusOverride || PUBLISH_CONFIG.defaultStatus,
    categories: categoryId ? [categoryId] : [],
    tags: content.tags || [],
    meta,
  };

  // 미디어 ID가 있으면 featured_media로, 없으면 URL로 폴백
  if (featuredMediaId) {
    postData.featured_media = featuredMediaId;
  } else if (content.heroImage?.url) {
    postData.featured_image_url = content.heroImage.url;
  }

  const post = await bridgeApiCall(env, 'posts', 'POST', postData);

  console.log(`[WordPress] 발행 완료: ${post.link} (ID: ${post.id}, Status: ${post.status})`);

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: post.title,
    publishedAt: new Date().toISOString(),
  };
}

// ─── WordPress 게시글 수정 ───
export async function updateWordPressPost(env, wpPostId, updates) {
  console.log(`[WordPress] 게시글 수정 시작 (Bridge API): ID ${wpPostId}`);

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
    postData.tags = tagNames;
  }
  if (updates.metaDescription) {
    postData.meta = {
      _yoast_wpseo_title: updates.title || '',
      _yoast_wpseo_metadesc: updates.metaDescription,
    };
  }

  const post = await bridgeApiCall(env, `posts/${wpPostId}`, 'PUT', postData);
  console.log(`[WordPress] 게시글 수정 완료: ${post.link} (ID: ${post.id})`);

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: post.title,
  };
}

// ─── 최근 발행 목록 조회 (WP REST API v2 직접 호출 — 인증 불필요) ───
export async function getRecentPosts(env, count = 10) {
  try {
    const site = env.WP_SITE_ID || 'mongclinic.blog';
    const response = await fetch(`https://${site}/wp-json/wp/v2/posts?per_page=${count}&orderby=date&order=desc`);
    if (!response.ok) return [];
    const results = await response.json();
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

// ─── WordPress 연결 상태 확인 (Bridge check 엔드포인트) ───
export async function checkConnection(env) {
  try {
    if (!env.WP_AUTH_KEY) return { connected: false, error: 'WP_AUTH_KEY 미설정' };

    const result = await bridgeApiCall(env, 'check');
    return {
      connected: result.connected || result.status === 'ok',
      siteName: result.site || 'Unknown',
      siteUrl: result.url || `https://${env.WP_SITE_ID || 'mongclinic.blog'}`,
    };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}
