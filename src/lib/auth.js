/**
 * 인증 토큰 관리 (관리자 + 광고주)
 */
import crypto from 'crypto';

export var ADMIN_TOKENS = new Map();
export var CLIENT_TOKENS = new Map();
export var TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1시간

export function genToken() {
  try { return crypto.randomBytes(24).toString('hex'); }
  catch(e) { var t='';var ch='abcdefghijklmnopqrstuvwxyz0123456789';for(var i=0;i<48;i++)t+=ch[Math.floor(Math.random()*ch.length)];return t; }
}

export function verifyAdminToken(req) {
  var a = req.headers['authorization'];
  if (!a || !a.startsWith('Bearer ')) return false;
  var tk = a.slice(7);
  var entry = ADMIN_TOKENS.get(tk);
  if (!entry) return false;
  if (Date.now() - new Date(entry.at).getTime() > TOKEN_EXPIRY_MS) {
    ADMIN_TOKENS.delete(tk);
    return false;
  }
  return true;
}

export function verifyToken(req) {
  var a = req.headers['authorization'];
  if (!a || !a.startsWith('Bearer ')) return false;
  var tk = a.slice(7);
  var entry = CLIENT_TOKENS.get(tk);
  if (!entry) return false;
  if (Date.now() - new Date(entry.at).getTime() > TOKEN_EXPIRY_MS) {
    CLIENT_TOKENS.delete(tk);
    return false;
  }
  return true;
}

// 10분마다 만료 토큰 정리
setInterval(function() {
  var now = Date.now();
  CLIENT_TOKENS.forEach(function(val, key) {
    if (now - new Date(val.at).getTime() > TOKEN_EXPIRY_MS) CLIENT_TOKENS.delete(key);
  });
  ADMIN_TOKENS.forEach(function(val, key) {
    if (now - new Date(val.at).getTime() > TOKEN_EXPIRY_MS) ADMIN_TOKENS.delete(key);
  });
}, 10 * 60 * 1000);
