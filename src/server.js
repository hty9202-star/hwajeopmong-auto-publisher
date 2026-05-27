/**
 * 화접몹 GEO Auto-Publisher 서버 (Node.js + Supabase)
 * Supabase PostgreSQL로 데이터 관리
 *
 * 실행: node src/server.js
 * 환경변수: Render 대시보드 또는 .env에서 설정
 */

import http from 'http';

// ─── 라이브러리 ───
import { saveErrorLog, jsonRes } from './lib/helpers.js';
import './lib/auth.js'; // 토큰 정리 인터벌 시작
import { setupCronSchedule, loadImageApiKeys } from './lib/publisher.js';
import { setupCitationCron } from './lib/citation.js';

// ─── 라우트 핸들러 ───
import { handleAdminRoutes } from './routes/admin.js';
import { handleClientRoutes } from './routes/client.js';
import { handleCitationRoutes } from './routes/citation.js';
import { handleReportRoutes } from './routes/report.js';

const PORT = process.env.PORT || 3000;

// ─── 초기화 ───
setupCronSchedule().catch(function(e) { console.error('[Server] cron 스케줄 초기화 실패:', e.message); });
loadImageApiKeys().catch(function(e) { console.error('[Server] 이미지 API 키 IIFE 예외:', e.message); });
setupCitationCron().catch(function(e) { console.error('[Server] 인용추적 cron 초기화 실패:', e.message); });

// ─── HTTP 서버 ───
const server = http.createServer(async function(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;
  const method = req.method;

  // CORS
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers['origin'] || '';
  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  try {
    // 라우트 순서: 관리자 → 클라이언트 → 인용추적 → 리포트 → 404
    if (await handleAdminRoutes(req, res, pathname, method, url)) return;
    if (await handleClientRoutes(req, res, pathname, method, url)) return;
    if (await handleCitationRoutes(req, res, pathname, method, url)) return;
    if (await handleReportRoutes(req, res, pathname, method, url)) return;

    // 404
    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    console.error('Server error:', error);
    await saveErrorLog('서버오류', error);
    jsonRes(res, { error: error.message }, 500);
  }
});

// ─── 전역 예외 핸들러 (프로세스 종료 방지) ───
process.on('unhandledRejection', function(reason) {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  saveErrorLog('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))).catch(function() {});
});

process.on('uncaughtException', function(err) {
  console.error('[FATAL] Uncaught Exception:', err);
  saveErrorLog('uncaughtException', err).catch(function() {});
  setTimeout(function() { process.exit(1); }, 1000);
});

server.listen(PORT, function() {
  console.log('[Server] 화접몹 GEO Auto-Publisher 실행 중 (Supabase DB)');
  console.log('[Server] 대시보드: http://localhost:' + PORT + '/dashboard');
  console.log('[Server] 광고주: http://localhost:' + PORT + '/client');
  console.log('[Server] API: http://localhost:' + PORT + '/api/status');
});
