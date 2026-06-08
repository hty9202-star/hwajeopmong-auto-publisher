/**
 * 공용 유틸리티 함수
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { settings } from '../supabase-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

// HTML 파일 캐싱 (매 요청마다 readFileSync 방지)
const HTML_CACHE = {};
export function getHtml(filename) {
  if (!HTML_CACHE[filename]) {
    HTML_CACHE[filename] = fs.readFileSync(srcDir + '/' + filename, 'utf-8');
  }
  return HTML_CACHE[filename];
}

// JSON 응답 헬퍼 (이미 응답 전송된 경우 무시)
export function jsonRes(res, data, status) {
  if (res.headersSent) {
    console.warn('[jsonRes] 이미 응답 전송됨, 중복 응답 무시:', JSON.stringify(data).slice(0, 100));
    return;
  }
  status = status || 200;
  res.writeHead(status, { 'Content-Type': "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// 공용 body 파싱 유틸 (최대 1MB 제한)
const MAX_BODY_SIZE = 1 * 1024 * 1024;
export function parseBody(req) {
  return new Promise(function(resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function(ch) {
      size += ch.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('요청 크기 초과 (최대 1MB)'));
        return;
      }
      // Buffer를 그대로 모은다 (멀티바이트 한글이 청크 경계에서 깨지지 않도록)
      chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
    });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', function(e) {
      reject(e);
    });
  });
}

// 공용 동시실행 제한 유틸
export async function runWithConcurrency(tasks, limit) {
  const results = [];
  let idx = 0;
  async function next() {
    const i = idx++;
    if (i >= tasks.length) return;
    results[i] = await tasks[i]();
    await next();
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, tasks.length); w++) workers.push(next());
  await Promise.all(workers);
  return results;
}

// 에러 로그 저장 헬퍼 (UTC ISO 형식 — 대시보드에서 KST로 변환 표시)
export async function saveErrorLog(source, error) {
  try {
    const existing = await settings.get('error_logs');
    const logs = Array.isArray(existing) ? existing : [];
    logs.unshift({
      timestamp: new Date().toISOString(),
      source: source,
      message: error.message || String(error),
      stack: error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : '',
    });
    if (logs.length > 100) logs.length = 100;
    await settings.set('error_logs', logs);
  } catch (logErr) {
    console.error('에러 로그 저장 실패:', logErr);
  }
}
