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

// JSON 응답 헬퍼
export function jsonRes(res, data, status) {
  status = status || 200;
  res.writeHead(status, { 'Content-Type': "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// 공용 body 파싱 유틸 (최대 1MB 제한)
const MAX_BODY_SIZE = 1 * 1024 * 1024;
export function parseBody(req) {
  return new Promise(function(resolve, reject) {
    let body = '';
    let size = 0;
    req.on('data', function(ch) {
      size += ch.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('요청 크기 초과 (최대 1MB)'));
        return;
      }
      body += ch;
    });
    req.on('end', function() {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
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

// 에러 로그 저장 헬퍼
export async function saveErrorLog(source, error) {
  try {
    const existing = await settings.get('error_logs');
    const logs = Array.isArray(existing) ? existing : [];
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    logs.unshift({
      timestamp: kst.toISOString(),
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
