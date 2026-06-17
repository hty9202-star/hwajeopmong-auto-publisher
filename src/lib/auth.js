/**
 * 인증 토큰 관리 (관리자 + 광고주)
 * 토큰을 메모리(Map)에 캐시하되 settings 테이블에 해시로 영속 저장한다.
 * 서버 재시작/배포 후에도 startup 시 DB에서 로드해 로그인이 유지된다.
 */
import crypto from 'crypto';
import { settings } from '../supabase-client.js';

export var ADMIN_TOKENS = new Map();  // key: tokenHash, val: { id, at }
export var CLIENT_TOKENS = new Map();
export var TOKEN_EXPIRY_MS = 5 * 60 * 60 * 1000; // 5시간

const SETTINGS_KEY = 'auth_tokens';

export function genToken() {
  try { return crypto.randomBytes(24).toString('hex'); }
  catch (e) { var t = ''; var ch = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (var i = 0; i < 48; i++) t += ch[Math.floor(Math.random() * ch.length)]; return t; }
}

function hashToken(tk) {
  return crypto.createHash('sha256').update(String(tk)).digest('hex');
}

function isExpired(at) {
  return Date.now() - new Date(at).getTime() > TOKEN_EXPIRY_MS;
}

// 전체 토큰을 settings에 직렬화 저장 (해시 기준, 평문 토큰은 저장하지 않음)
async function persistTokens() {
  try {
    var blob = {};
    ADMIN_TOKENS.forEach(function (val, hash) { blob[hash] = { kind: 'admin', id: val.id, at: val.at }; });
    CLIENT_TOKENS.forEach(function (val, hash) { blob[hash] = { kind: 'client', id: val.id, at: val.at }; });
    await settings.set(SETTINGS_KEY, blob);
  } catch (e) { console.error('[auth] 토큰 영속 실패:', e.message); }
}

// 로그인 시 호출: 토큰 저장 (메모리 + DB)
export async function saveToken(tk, kind, userId) {
  var hash = hashToken(tk);
  var entry = { id: userId, at: new Date().toISOString() };
  if (kind === 'admin') ADMIN_TOKENS.set(hash, entry);
  else CLIENT_TOKENS.set(hash, entry);
  await persistTokens();
}

// 서버 시작 시 호출: DB에서 토큰 로드 (재시작 후 로그인 유지)
export async function loadTokensFromDB() {
  try {
    var blob = await settings.get(SETTINGS_KEY);
    if (!blob || typeof blob !== 'object') return;
    var loaded = 0;
    Object.keys(blob).forEach(function (hash) {
      var v = blob[hash];
      if (!v || isExpired(v.at)) return;
      if (v.kind === 'admin') ADMIN_TOKENS.set(hash, { id: v.id, at: v.at });
      else CLIENT_TOKENS.set(hash, { id: v.id, at: v.at });
      loaded++;
    });
    console.log('[auth] DB에서 토큰 ' + loaded + '개 로드');
  } catch (e) { console.error('[auth] 토큰 로드 실패:', e.message); }
}

export function verifyAdminToken(req) {
  var a = req.headers['authorization'];
  if (!a || !a.startsWith('Bearer ')) return false;
  var hash = hashToken(a.slice(7));
  var entry = ADMIN_TOKENS.get(hash);
  if (!entry) return false;
  if (isExpired(entry.at)) { ADMIN_TOKENS.delete(hash); return false; }
  return true;
}

export function verifyToken(req) {
  var a = req.headers['authorization'];
  if (!a || !a.startsWith('Bearer ')) return false;
  var hash = hashToken(a.slice(7));
  var entry = CLIENT_TOKENS.get(hash);
  if (!entry) return false;
  if (isExpired(entry.at)) { CLIENT_TOKENS.delete(hash); return false; }
  return true;
}

// 10분마다 만료 토큰 정리 (메모리 + DB)
setInterval(function () {
  var changed = false;
  CLIENT_TOKENS.forEach(function (val, key) { if (isExpired(val.at)) { CLIENT_TOKENS.delete(key); changed = true; } });
  ADMIN_TOKENS.forEach(function (val, key) { if (isExpired(val.at)) { ADMIN_TOKENS.delete(key); changed = true; } });
  if (changed) persistTokens();
}, 10 * 60 * 1000);
