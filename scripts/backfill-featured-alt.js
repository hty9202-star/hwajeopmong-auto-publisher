/**
 * 일회용: 기존 발행 글의 대표이미지(featured image)에 alt(대체 텍스트) 백필
 *
 * 안전성:
 *  - 미디어의 alt_text 메타만 채움 (글 재발행 X → 글 수정일/검색엔진 재핑 영향 없음)
 *  - 이미 alt가 있는 이미지는 건너뜀 (덮어쓰지 않음)
 *  - --dry 옵션으로 실제 변경 없이 미리보기 가능
 *
 * 실행 (PC 터미널):
 *   cd C:\project\hwajeopmong-auto-publisher
 *   node scripts/backfill-featured-alt.js --dry      # 미리보기
 *   node scripts/backfill-featured-alt.js            # 실제 적용
 *
 * 필요 env (.env 또는 환경변수): WP_REST_USER, WP_REST_PASS, (선택) WP_SITE_ID
 */
import fs from 'fs';
import path from 'path';

function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

const SITE = process.env.WP_SITE_ID || 'mongclinic.blog';
const USER = process.env.WP_REST_USER;
const PASS = process.env.WP_REST_PASS;
const DRY_RUN = process.argv.includes('--dry');

if (!USER || !PASS) {
  console.error('[백필] WP_REST_USER / WP_REST_PASS 환경변수가 필요합니다 (.env 확인)');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const BASE = `https://${SITE}/wp-json/wp/v2`;

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getAllPosts() {
  let page = 1, all = [];
  while (true) {
    const url = `${BASE}/posts?per_page=100&page=${page}&status=publish&_fields=id,title,featured_media`;
    const r = await fetch(url, { headers: { Authorization: AUTH } });
    if (r.status === 400) break; // 페이지 초과
    if (!r.ok) throw new Error(`posts 조회 실패: ${r.status} ${(await r.text()).slice(0, 150)}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    const totalPages = parseInt(r.headers.get('x-wp-totalpages') || '1', 10);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

async function getMediaAlt(id) {
  const r = await fetch(`${BASE}/media/${id}?_fields=id,alt_text`, { headers: { Authorization: AUTH } });
  if (!r.ok) return null;
  const m = await r.json();
  return m.alt_text || '';
}

async function setMediaAlt(id, alt) {
  const r = await fetch(`${BASE}/media/${id}`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ alt_text: alt }),
  });
  if (!r.ok) throw new Error(`media ${id} alt 설정 실패: ${r.status} ${(await r.text()).slice(0, 150)}`);
}

(async () => {
  console.log(`[백필] 사이트: ${SITE} | DRY_RUN: ${DRY_RUN}`);
  const posts = await getAllPosts();
  console.log(`[백필] 발행 글 ${posts.length}건 조회됨`);

  let set = 0, skipped = 0, noImg = 0;
  for (const p of posts) {
    const mediaId = p.featured_media;
    if (!mediaId) { noImg++; continue; }

    const title = stripHtml(p.title && p.title.rendered);
    const alt = title || '화접몽한의원 강남본점';

    const existing = await getMediaAlt(mediaId);
    if (existing && existing.trim()) {
      console.log(`  - skip  post ${p.id} (이미 alt 있음: "${existing.slice(0, 30)}")`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  - [dry] post ${p.id} / media ${mediaId} ← "${alt}"`);
      set++;
      continue;
    }

    await setMediaAlt(mediaId, alt);
    console.log(`  - set   post ${p.id} / media ${mediaId} ← "${alt}"`);
    set++;
  }

  console.log(`[백필] 완료 — ${DRY_RUN ? '(미리보기)' : '적용'} 대상 ${set}건, 이미있음 skip ${skipped}건, 대표이미지없음 ${noImg}건`);
})().catch((e) => { console.error('[백필] 오류:', e.message); process.exit(1); });
