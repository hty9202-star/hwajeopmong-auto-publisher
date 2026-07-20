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

// ─── 글 메타만 갱신 (Bridge /posts/{id}/meta) — 스키마 메타 재전송용 ───
export async function updatePostMetaViaBridge(env, postId, meta) {
  return bridgeApiCall(env, `posts/${postId}/meta`, 'POST', { meta: meta });
}

// ─── WP REST API 직접 호출 (Application Password 인증) ───
function getWpRestAuth(env) {
  // 방법 1: env 객체에서 WP_REST_USER + WP_REST_PASS
  const user = env.WP_REST_USER || process.env.WP_REST_USER;
  const pass = env.WP_REST_PASS || process.env.WP_REST_PASS;
  if (user && pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  // 방법 2: WP_AUTH_KEY가 "user:pass" 형태인 경우
  const authKey = env.WP_AUTH_KEY || process.env.WP_AUTH_KEY;
  if (authKey && authKey.includes(':')) {
    return 'Basic ' + Buffer.from(authKey).toString('base64');
  }
  console.warn('[WordPress] getWpRestAuth: 인증 정보 없음 — env.WP_REST_USER:', !!env.WP_REST_USER, 'process.env.WP_REST_USER:', !!process.env.WP_REST_USER);
  return null;
}

async function wpRestCall(env, endpoint, method = 'GET', body = null) {
  const site = env.WP_SITE_ID || 'mongclinic.blog';
  const url = `https://${site}/wp-json/wp/v2/${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  const auth = getWpRestAuth(env);
  if (auth) headers['Authorization'] = auth;
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`WP REST ${method} ${endpoint}: ${resp.status}`);
  return resp.json();
}

// ─── 발행 후 WP REST API로 메타 필드 + 대표 이미지 설정 ───
async function updatePostMetaViaRestApi(env, wpPostId, meta, featuredMediaId) {
  const auth = getWpRestAuth(env);
  if (!auth) {
    console.log('[WordPress] WP REST API 인증 미설정 — 메타/이미지 업데이트 건너뜀 (WP_REST_USER + WP_REST_PASS 필요)');
    return false;
  }

  try {
    const updateData = {};

    // Yoast SEO 메타 필드
    if (meta && Object.keys(meta).length > 0) {
      updateData.meta = meta;
    }

    // 대표 이미지
    if (featuredMediaId) {
      updateData.featured_media = featuredMediaId;
    }

    if (Object.keys(updateData).length === 0) return true;

    console.log(`[WordPress] REST API로 메타 업데이트 시작: post ${wpPostId}, 필드: ${Object.keys(updateData).join(', ')}`);
    await wpRestCall(env, `posts/${wpPostId}`, 'POST', updateData);
    console.log(`[WordPress] REST API 메타 업데이트 완료: post ${wpPostId}`);
    return true;
  } catch (e) {
    console.error(`[WordPress] REST API 메타 업데이트 실패 (post ${wpPostId}):`, e.message);
    return false;
  }
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

  // 방법 1: Bridge API로 업로드 시도
  try {
    console.log(`[이미지 업로드] Hero 이미지 Bridge 업로드: ${imageData.url.substring(0, 80)}`);
    const result = await bridgeApiCall(env, 'media', 'POST', {
      url: imageData.url,
    });
    if (result && result.id) return result.id;
  } catch (e) {
    console.warn('[이미지 업로드] Bridge 실패, WP REST API 폴백 시도:', e.message);
  }

  // 방법 2: WP REST API로 직접 이미지 다운로드 후 업로드 (폴백)
  return await uploadImageViaRestApi(env, imageData.url);
}

// ─── WP REST API로 이미지 직접 업로드 (Application Password) ───
async function uploadImageViaRestApi(env, imageUrl) {
  const auth = getWpRestAuth(env);
  if (!auth) {
    console.log('[이미지 업로드] WP REST API 인증 미설정 — 이미지 업로드 건너뜀');
    return null;
  }

  try {
    // 1. 이미지 다운로드
    console.log(`[이미지 업로드] REST API: 이미지 다운로드 중 ${imageUrl.substring(0, 80)}`);
    const imgResp = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 HWJ-AutoPublisher/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!imgResp.ok) throw new Error(`이미지 다운로드 실패: ${imgResp.status}`);

    const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = Buffer.from(await imgResp.arrayBuffer());
    console.log(`[이미지 업로드] REST API: 다운로드 완료 (${(imageBuffer.length / 1024).toFixed(1)}KB)`);

    // 2. 파일명 추출
    const urlPath = new URL(imageUrl).pathname;
    let filename = urlPath.split('/').pop() || 'hero-image.jpg';
    if (!filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      filename = 'hero-image.jpg';
    }

    // 3. WP REST API media 엔드포인트로 업로드
    const site = env.WP_SITE_ID || 'mongclinic.blog';
    const uploadUrl = `https://${site}/wp-json/wp/v2/media`;
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: imageBuffer,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw new Error(`미디어 업로드 실패: ${uploadResp.status} - ${errText.substring(0, 200)}`);
    }

    const mediaData = await uploadResp.json();
    console.log(`[이미지 업로드] REST API 성공: media ID ${mediaData.id}`);
    return mediaData.id;
  } catch (e) {
    console.error('[이미지 업로드] REST API 폴백도 실패:', e.message);
    return null;
  }
}

// ─── 업로드한 미디어(대표이미지)에 alt(대체 텍스트) 설정 ───
// 네이버 색인 'Alt 속성 누락' 방지 + 접근성/SEO. Bridge·REST 어느 경로로 올렸든 media ID만 있으면 동작.
async function setMediaAltViaRestApi(env, mediaId, altText) {
  if (!mediaId || !altText) return;
  const auth = getWpRestAuth(env);
  if (!auth) {
    console.log('[이미지 alt] WP REST 인증 미설정 — 대표이미지 alt 설정 건너뜀');
    return;
  }
  try {
    const site = env.WP_SITE_ID || 'mongclinic.blog';
    const url = `https://${site}/wp-json/wp/v2/media/${mediaId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt_text: altText }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.warn(`[이미지 alt] 설정 실패: ${resp.status} - ${t.substring(0, 150)}`);
      return;
    }
    console.log(`[이미지 alt] 대표이미지 alt 설정 완료: media ${mediaId} → "${altText}"`);
  } catch (e) {
    console.warn(`[이미지 alt] 설정 예외: ${e.message}`);
  }
}

// ─── 단일 이미지를 Bridge를 통해 WordPress에 업로드 ───
// 생성 단계(content-generator)에서도 호출 → 외부 임시 URL을 즉시 영구 URL로 전환
export async function uploadImageToWP(env, imageUrl) {
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
      // 업로드 실패 → 깨진 외부 URL을 본문에 남기지 않고 해당 이미지 블록 제거
      // (외부 임시 URL은 만료·핫링크 차단으로 깨지므로, 깨진 이미지보다 없는 게 낫다)
      htmlContent = removeImageBlock(htmlContent, r.originalUrl);
      console.warn(`[이미지 업로드] ${i + 1}/${replacements.length} 실패 — 깨진 이미지 블록 제거: ${r.originalUrl.substring(0, 80)}`);
    }
  }

  return htmlContent;
}

// ─── 업로드 실패한 이미지의 figure 블록(또는 img 태그)을 본문에서 제거 ───
function removeImageBlock(htmlContent, brokenUrl) {
  // 정규식 특수문자 이스케이프
  const esc = brokenUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 1순위: 해당 URL을 감싼 <figure>...</figure> 통째 제거 (figcaption 출처까지 정리)
  const figureRe = new RegExp(`<figure[^>]*>(?:(?!</figure>)[\\s\\S])*?${esc}[\\s\\S]*?</figure>\\s*`, 'i');
  if (figureRe.test(htmlContent)) {
    return htmlContent.replace(figureRe, '');
  }
  // 2순위: figure가 없으면 해당 <img> 태그만 제거
  const imgRe = new RegExp(`<img\\s[^>]*?src="${esc}"[^>]*>\\s*`, 'i');
  return htmlContent.replace(imgRe, '');
}

// ─── 대표이미지 URL을 폴백으로 써도 안전한지 판단 ───
// 우리 워드프레스 미디어(영구 URL)이거나, 미디어 업로드가 성공한 경우에만 안전.
// 외부 임시 URL(Pixabay/Unsplash 등)은 깨질 수 있어 폴백으로 쓰지 않는다.
function isSafeImageUrl(url, featuredMediaId) {
  if (!url) return false;
  if (featuredMediaId) return true; // 업로드 성공 → 미디어 ID가 우선, URL은 보조로 무방
  return /(?:wordpress\.com|wp\.com|mongclinic\.blog)/i.test(url);
}

// ─── 메인 발행 함수 ───
export async function publishToWordPress(env, content, statusOverride) {
  console.log(`[WordPress] 발행 시작 (Bridge API): ${content.title}`);

  // 1. 본문 내 외부 이미지를 WordPress 미디어 라이브러리로 업로드 후 URL 교체
  const processedContent = await uploadInlineImages(env, content.content);

  // 2. 카테고리 ID 조회 또는 생성
  const categoryId = await resolveCategory(env, content.category);

  // 3. 글 발행 (Bridge API)
  // _yoast_wpseo_title은 일부러 설정하지 않는다.
  // 값을 넣으면 글마다 SEO 타이틀이 고정돼 Yoast 전역 제목 템플릿
  // (%%title%% %%sep%% %%sitename%% → "제목 | 화접몽한의원 강남본점")이 무시된다.
  // 브랜드·지역 접미는 Yoast 전역 설정에서 일괄 관리한다.
  const meta = {
    _yoast_wpseo_metadesc: content.metaDescription || '',
    _yoast_wpseo_focuskw: content.focusKeyphrase || '',
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
      // 대표이미지 alt 설정 (네이버 'Alt 속성 누락' 방지)
      const featuredAlt = content.title || (content.category ? `${content.category} 한방 치료 관련 이미지 - 화접몽한의원 강남본점` : '화접몽한의원 강남본점');
      await setMediaAltViaRestApi(env, featuredMediaId, featuredAlt);
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

  // featured_media (ID) + featured_image_url (URL) 둘 다 전송
  // Bridge 플러그인이 featured_media 우선, URL은 폴백으로 사용
  if (featuredMediaId) {
    postData.featured_media = featuredMediaId;
  }
  // URL 폴백은 "안전한 경우"에만 — 우리 워드프레스 미디어 URL이거나 업로드가 성공했을 때만.
  // 외부 임시 URL(Pixabay/Unsplash 등)은 깨질 수 있으므로 업로드 실패 시 폴백으로 쓰지 않는다.
  if (content.heroImage?.url && isSafeImageUrl(content.heroImage.url, featuredMediaId)) {
    postData.featured_image_url = content.heroImage.url;
  } else if (content.heroImage?.url && !featuredMediaId) {
    console.warn(`[WordPress] 대표 이미지 업로드 실패 + 외부 URL → 대표이미지 설정 생략 (깨진 이미지 방지)`);
  }

  const post = await bridgeApiCall(env, 'posts', 'POST', postData);

  console.log(`[WordPress] 발행 완료: ${post.link} (ID: ${post.id}, Status: ${post.status})`);

  // 4. featured_media를 Bridge API PUT으로 확실히 설정 (URL 폴백 포함)
  if (post.id && (featuredMediaId || content.heroImage?.url)) {
    try {
      const putData = {};
      if (featuredMediaId) putData.featured_media = featuredMediaId;
      if (content.heroImage?.url && isSafeImageUrl(content.heroImage.url, featuredMediaId)) putData.featured_image_url = content.heroImage.url;
      console.log(`[WordPress] Bridge PUT으로 featured image 설정: post ${post.id}, keys: ${Object.keys(putData).join(',')}`);
      await bridgeApiCall(env, `posts/${post.id}`, 'PUT', putData);
      console.log(`[WordPress] Bridge PUT featured image 설정 완료`);
    } catch (e) {
      console.warn(`[WordPress] Bridge PUT featured image 실패: ${e.message}`);
    }
  }

  // 5. WP REST API로 메타 필드 보완 (featured_media는 이미 Bridge로 설정됨)
  if (post.id) {
    await updatePostMetaViaRestApi(env, post.id, meta, featuredMediaId);
  }

  // 6. 검색엔진 인덱싱 알림 (실패해도 발행 결과에 영향 없음)
  if (post.link) {
    notifySearchEngines(env, post.link).catch(function(e) {
      console.warn('[IndexNow] 검색엔진 알림 실패 (무시):', e.message);
    });
  }

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: post.title,
    publishedAt: new Date().toISOString(),
  };
}

// ─── 검색엔진 인덱싱 알림 (IndexNow + Google Sitemap Ping) ───
async function notifySearchEngines(env, postUrl) {
  const site = env.WP_SITE_ID || 'mongclinic.blog';
  const sitemapUrl = 'https://' + site + '/sitemap_index.xml';
  const results = [];

  // 1. Google Sitemap Ping
  try {
    const gResp = await fetch('https://www.google.com/ping?sitemap=' + encodeURIComponent(sitemapUrl), {
      signal: AbortSignal.timeout(5000),
    });
    results.push('Google: ' + gResp.status);
  } catch (e) {
    results.push('Google: fail');
  }

  // 2. IndexNow (Bing, Yandex, Naver 등 동시 지원)
  const indexNowKey = env.INDEXNOW_API_KEY;
  if (indexNowKey) {
    try {
      const inResp = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: site,
          key: indexNowKey,
          keyLocation: 'https://' + site + '/' + indexNowKey + '.txt',
          urlList: [postUrl],
        }),
        signal: AbortSignal.timeout(5000),
      });
      results.push('IndexNow: ' + inResp.status);
    } catch (e) {
      results.push('IndexNow: fail');
    }
  }

  // 3. Bing Sitemap Ping (IndexNow 없어도 동작)
  try {
    const bResp = await fetch('https://www.bing.com/ping?sitemap=' + encodeURIComponent(sitemapUrl), {
      signal: AbortSignal.timeout(5000),
    });
    results.push('Bing: ' + bResp.status);
  } catch (e) {
    results.push('Bing: fail');
  }

  console.log('[검색엔진 알림] ' + postUrl + ' → ' + results.join(', '));
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
  const meta = {};
  if (updates.metaDescription) {
    // _yoast_wpseo_title 미설정 — Yoast 전역 제목 템플릿을 사용한다(위 발행 로직과 동일 정책)
    meta._yoast_wpseo_metadesc = updates.metaDescription;
    postData.meta = meta;
  }

  const post = await bridgeApiCall(env, `posts/${wpPostId}`, 'PUT', postData);
  console.log(`[WordPress] 게시글 수정 완료: ${post.link} (ID: ${post.id})`);

  // Bridge가 처리하지 못하는 메타 필드를 WP REST API로 보완
  if (Object.keys(meta).length > 0) {
    await updatePostMetaViaRestApi(env, wpPostId, meta, null);
  }

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
