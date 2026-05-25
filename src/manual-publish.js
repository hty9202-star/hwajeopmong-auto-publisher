#!/usr/bin/env node
/**
 * 수동 발행 스크립트
 * 사용법:
 *   node src/manual-publish.js                          # 다음 토픽 자동 선택
 *   node src/manual-publish.js --topic acne --type faq  # 특정 토픽+유형 지정
 *   node src/manual-publish.js --dry-run                # 생성만 하고 발행 안 함
 */

import { TOPICS, CONTENT_TYPES, getNextTopic } from './config.js';
import { generateContent } from './content-generator.js';
import { publishToWordPress } from './wordpress-publisher.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KV_PATH = path.join(__dirname, '../data');

// ─── 간단한 KV ───
if (!fs.existsSync(KV_PATH)) fs.mkdirSync(KV_PATH, { recursive: true });
const kvGet = (key) => {
  try { return fs.readFileSync(path.join(KV_PATH, `${key}.json`), 'utf-8'); }
  catch { return null; }
};
const kvPut = (key, val) => fs.writeFileSync(path.join(KV_PATH, `${key}.json`), val);

// ─── 인자 파싱 ───
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WP_SITE_ID: process.env.WP_SITE_ID || 'mongclinic.blog',
  WP_ACCESS_TOKEN: process.env.WP_ACCESS_TOKEN,
  PEXELS_API_KEY: process.env.PEXELS_API_KEY,
};

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  화접몽 한의원 GEO Auto-Publisher');
  console.log('  수동 발행 모드');
  console.log('═══════════════════════════════════════════\n');

  // API 키 체크
  if (!env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
    process.exit(1);
  }
  if (!env.WP_ACCESS_TOKEN) {
    console.log('⚠️  WP_ACCESS_TOKEN 미설정. --dry-run 모드로 실행됩니다.');
  }

  // 토픽 선택
  let topic, contentType;
  const topicArg = getArg('topic');
  const typeArg = getArg('type');

  if (topicArg) {
    topic = TOPICS.find(t => t.id === topicArg || t.slug === topicArg);
    if (!topic) {
      console.error(`❌ 토픽을 찾을 수 없습니다: ${topicArg}`);
      console.log('사용 가능한 토픽:', TOPICS.map(t => t.id).join(', '));
      process.exit(1);
    }
  }
  if (typeArg) {
    contentType = CONTENT_TYPES.find(ct => ct.id === typeArg || ct.id.includes(typeArg));
    if (!contentType) {
      console.error(`❌ 콘텐츠 유형을 찾을 수 없습니다: ${typeArg}`);
      console.log('사용 가능한 유형:', CONTENT_TYPES.map(ct => ct.id).join(', '));
      process.exit(1);
    }
  }

  if (!topic || !contentType) {
    const publishedRaw = kvGet('published_topics');
    const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
    const next = getNextTopic(publishedTopicIds);
    topic = topic || next.topic;
    contentType = contentType || next.contentType;
  }

  const comboId = `${topic.id}__${contentType.id}`;
  console.log(`📋 토픽: ${topic.name} (${topic.nameEn})`);
  console.log(`📝 유형: ${contentType.name}`);
  console.log(`🔑 콤보: ${comboId}`);
  console.log(`🔄 드라이런: ${hasFlag('dry-run') ? '예' : '아니오'}\n`);

  // Stage 1-3: 콘텐츠 생성
  console.log('─── 콘텐츠 생성 시작 ───');
  const startTime = Date.now();
  const content = await generateContent(env, topic, contentType);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ 콘텐츠 생성 완료 (${elapsed}초)`);
  console.log(`   제목: ${content.title}`);
  console.log(`   슬러그: ${content.slug}`);
  console.log(`   태그: ${content.tags.join(', ')}`);
  console.log(`   FAQ: ${content.faq.length}개`);
  console.log(`   스키마: ${content.schemas.length}개`);

  // 미리보기 저장
  const previewPath = path.join(KV_PATH, `preview_${comboId}.html`);
  fs.writeFileSync(previewPath, `
<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>${content.title}</title>
<style>body{max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.8;padding:0 20px;}
h1{color:#1B4F72;}h2{color:#2E75B6;margin-top:32px;}h3{color:#374EA2;}
table{border-collapse:collapse;width:100%;margin:16px 0;}th,td{border:1px solid #ddd;padding:8px 12px;}
th{background:#f3f4f6;}.faq-item{margin:16px 0;padding:16px;background:#f8f9fa;border-radius:8px;}
.brand-cta{background:#f8f9fa;border-left:4px solid #2E75B6;padding:20px;margin:30px 0;}</style></head>
<body><h1>${content.title}</h1><p><em>${content.metaDescription}</em></p><hr/>${content.content}</body></html>`);
  console.log(`   미리보기: ${previewPath}`);

  // 드라이런이면 여기서 종료
  if (hasFlag('dry-run')) {
    console.log('\n🏁 드라이런 완료. WordPress 발행은 건너뜁니다.');
    return;
  }

  // WordPress 발행
  if (!env.WP_SITE_URL || !env.WP_APP_PASSWORD) {
    console.log('\n⚠️  WordPress 환경변수 미설정. 콘텐츠만 생성되었습니다.');
    console.log('    WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD를 설정하세요.');
    return;
  }

  console.log('\n─── WordPress 발행 시작 ───');
  const result = await publishToWordPress(env, content);
  console.log(`✅ 발행 완료!`);
  console.log(`   URL: ${result.link}`);
  console.log(`   상태: ${result.status}`);
  console.log(`   ID: ${result.id}`);

  // 발행 이력 업데이트
  const publishedRaw = kvGet('published_topics');
  const publishedTopicIds = publishedRaw ? JSON.parse(publishedRaw) : [];
  if (!publishedTopicIds.includes(comboId)) {
    publishedTopicIds.push(comboId);
    kvPut('published_topics', JSON.stringify(publishedTopicIds));
  }

  const logsRaw = kvGet('publish_logs');
  const logs = logsRaw ? JSON.parse(logsRaw) : [];
  logs.unshift({
    comboId,
    topicName: topic.name,
    contentType: contentType.name,
    title: content.title,
    wpLink: result.link,
    wpId: result.id,
    status: result.status,
    publishedAt: new Date().toISOString(),
    manual: true,
  });
  kvPut('publish_logs', JSON.stringify(logs.slice(0, 100)));

  console.log('\n🏁 완료!');
}

main().catch((err) => {
  console.error('\n❌ 에러 발생:', err.message);
  process.exit(1);
});
