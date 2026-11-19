// Timoneiro — backend sem dependências externas (Node 22+, SQLite embutido)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_SECRET = process.env.APP_SECRET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const CONFIG = {
  mentoriaUrl: process.env.MENTORIA_URL || '',
  lojaUrl: process.env.LOJA_URL || '',
  contato: process.env.CONTATO_EMAIL || '',
};
// Versão e texto exatos dos consentimentos (guardados no log a cada aceite)
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-11-16';
const TERMS_TEXT = 'Li e aceito os Termos de Uso e a Política de Privacidade.';
const MKT_TEXT = 'Quero receber por e-mail novidades, conteúdos e ofertas da mentoria e da loja (como camisetas). Posso cancelar quando quiser.';

if (APP_SECRET.length < 32 || ADMIN_TOKEN.length < 24) {
  console.error('ERRO: defina APP_SECRET (>=32 caracteres) e ADMIN_TOKEN (>=24 caracteres).');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'timoneiro.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  marketing INTEGER NOT NULL DEFAULT 0,
  terms_version TEXT NOT NULL,
  state TEXT,
  state_updated INTEGER NOT NULL DEFAULT 0,
  unsub_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  granted INTEGER NOT NULL,
  text_version TEXT NOT NULL,
  text TEXT NOT NULL,
  ip TEXT, ua TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_consent_user ON consent_log(user_id);
`);
const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email=?'),
  byId: db.prepare('SELECT * FROM users WHERE id=?'),
  byUnsub: db.prepare('SELECT * FROM users WHERE unsub_key=?'),
  insert: db.prepare('INSERT INTO users(name,email,pass_hash,created_at,last_seen,marketing,terms_version,unsub_key) VALUES(?,?,?,?,?,?,?,?)'),
  seen: db.prepare('UPDATE users SET last_seen=? WHERE id=?'),
  setState: db.prepare('UPDATE users SET state=?, state_updated=?, last_seen=? WHERE id=?'),
  setMkt: db.prepare('UPDATE users SET marketing=? WHERE id=?'),
  setPass: db.prepare('UPDATE users SET pass_hash=? WHERE id=?'),
  del: db.prepare('DELETE FROM users WHERE id=?'),
  log: db.prepare('INSERT INTO consent_log(user_id,kind,granted,text_version,text,ip,ua,at) VALUES(?,?,?,?,?,?,?,?)'),
  logsOf: db.prepare('SELECT kind,granted,text_version,text,ip,at FROM consent_log WHERE user_id=? ORDER BY at'),
  all: db.prepare('SELECT id,name,email,created_at,last_seen,marketing,state,state_updated FROM users ORDER BY last_seen DESC'),
  leads: db.prepare('SELECT name,email,created_at FROM users WHERE marketing=1 ORDER BY created_at'),
};

// ---------- segurança ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPass(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const DUMMY_HASH = hashPass(crypto.randomBytes(12).toString('hex'));
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(tok) {
  if (typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, mac] = tok.split('.');
  const exp = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac || ''), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hits = new Map();
function limited(ip, key, max = 20, winMs = 15 * 60e3) {
  const k = key + ip, now = Date.now(), e = hits.get(k);
  if (!e || e.reset < now) { hits.set(k, { n: 1, reset: now + winMs }); return false; }
  e.n++; return e.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60e3).unref();

// ---------- helpers HTTP ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function send(res, code, obj, extra = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
const fail = (res, code, msg) => send(res, code, { error: msg });
function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let over = false;
    req.on('data', (c) => { if (over) return; size += c.length; if (size > max) { over = true; chunks.length = 0; } else chunks.push(c); });
    req.on('end', () => { if (over) return reject(Object.assign(new Error('payload'), { code: 413 })); if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '').slice(0, 64);
const ua = (req) => String(req.headers['user-agent'] || '').slice(0, 200);
function authUser(req) {
  const h = String(req.headers.authorization || '');
  const p = verify(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return null;
  const u = q.byId.get(p.uid);
  return u && p.pv === u.pass_hash.slice(-10) ? u : null;
}
const isAdmin = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Admin ') && safeEq(h.slice(6), ADMIN_TOKEN); };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, marketing: !!u.marketing, createdAt: u.created_at });
const newToken = (u) => sign({ uid: u.id, pv: u.pass_hash.slice(-10), exp: Date.now() + 30 * 864e5 });
function summary(stateJson) {
  let s = {}; try { s = JSON.parse(stateJson || '{}') || {}; } catch {}
  const done = Object.keys(s.done || {});
  const ilhas = new Set(done.map((k) => parseInt(k, 10)));
  const order = []; for (let i = 0; i < 12; i++) order.push(i + 'l', i + 'b');
  const next = order.find((k) => !(s.done || {})[k]);
  return {
    xp: s.xp | 0, etapas: done.length, ilhasConcluidas: [...ilhas].filter((i) => s.done[i + 'l'] && s.done[i + 'b']).length,
    proxima: next ? `Ilha ${parseInt(next, 10)} · ${next.endsWith('b') ? 'tempestade' : 'treino'}` : 'Rota completa',
    estrelas: Object.values(s.stars || {}).reduce((a, b) => a + (b | 0), 0), uptime: s.up | 0, melhorUptime: s.best | 0,
  };
}
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };

// ---------- arquivos estáticos ----------
const PUB = path.join(__dirname, 'public');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'admin.html', '/privacidade': 'privacidade.html', '/favicon.svg': 'favicon.svg' };
const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, file) {
  const p = path.join(PUB, file);
  fs.readFile(p, (err, buf) => {
    if (err) return fail(res, 404, 'não encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
    res.end(buf);
  });
}

// ---------- rotas ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const ip = clientIp(req);

  if (m === 'GET' && STATIC[p]) return serveStatic(res, STATIC[p]);
  if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
  if (m === 'GET' && p === '/api/config') return send(res, 200, { ...CONFIG, termsVersion: TERMS_VERSION, termsText: TERMS_TEXT, marketingText: MKT_TEXT });

  if (m === 'POST' && p === '/api/register') {
    if (limited(ip, 'reg', 10)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (name.length < 2) return fail(res, 400, 'Informe seu nome.');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'E-mail inválido.');
    if (pw.length < 8 || pw.length > 200) return fail(res, 400, 'A senha precisa ter pelo menos 8 caracteres.');
    if (b.terms !== true) return fail(res, 400, 'É preciso aceitar os Termos e a Política de Privacidade.');
    if (q.byEmail.get(email)) return fail(res, 409, 'Este e-mail já tem conta. Use "Entrar".');
    const now = Date.now(), mkt = b.marketing === true ? 1 : 0;
    const r = q.insert.run(name, email, hashPass(pw), now, now, mkt, TERMS_VERSION, crypto.randomBytes(18).toString('base64url'));
    const uid = Number(r.lastInsertRowid);
    q.log.run(uid, 'terms', 1, TERMS_VERSION, TERMS_TEXT, ip, ua(req), now);
    q.log.run(uid, 'marketing', mkt, TERMS_VERSION, MKT_TEXT, ip, ua(req), now);
    if (b.state && typeof b.state === 'object') { const js = JSON.stringify(b.state); if (js.length < 60000) q.setState.run(js, now, now, uid); }
    const u = q.byId.get(uid);
    return send(res, 201, { token: newToken(u), user: publicUser(u), state: u.state ? JSON.parse(u.state) : null, stateUpdated: u.state_updated });
  }

  if (m === 'POST' && p === '/api/login') {
    if (limited(ip, 'login', 20)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
    const b = await readJson(req);
    const u = q.byEmail.get(String(b.email || '').trim().toLowerCase());
    const ok = checkPass(String(b.password || ''), u ? u.pass_hash : DUMMY_HASH) && !!u;
    if (!ok) return fail(res, 401, 'E-mail ou senha incorretos.');
    q.seen.run(Date.now(), u.id);
    return send(res, 200, { token: newToken(u), user: publicUser(u), state: u.state ? JSON.parse(u.state) : null, stateUpdated: u.state_updated });
  }

  if (m === 'GET' && p === '/api/unsubscribe') {
    const u = q.byUnsub.get(String(url.searchParams.get('k') || ''));
    if (u) { if (u.marketing) { q.setMkt.run(0, u.id); q.log.run(u.id, 'marketing', 0, TERMS_VERSION, 'Descadastro pelo link do e-mail', ip, ua(req), Date.now()); } }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;background:#050b1a;color:#eaf2ff;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h1>⚓ Pronto</h1><p>${u ? 'Você não vai mais receber e-mails promocionais.' : 'Link inválido ou já utilizado.'}</p><p><a style="color:#3fe0ff" href="/">Voltar ao jogo</a></p></div>`);
  }

  // ----- rotas do aluno (autenticadas) -----
  if (p.startsWith('/api/me')) {
    const u = authUser(req);
    if (!u) return fail(res, 401, 'Sessão expirada. Entre novamente.');
    if (m === 'GET' && p === '/api/me') { q.seen.run(Date.now(), u.id); return send(res, 200, { user: publicUser(u), state: u.state ? JSON.parse(u.state) : null, stateUpdated: u.state_updated }); }
    if (m === 'PUT' && p === '/api/me/progress') {
      const b = await readJson(req);
      if (!b.state || typeof b.state !== 'object') return fail(res, 400, 'Estado inválido.');
      const js = JSON.stringify(b.state); if (js.length > 60000) return fail(res, 413, 'Estado muito grande.');
      const now = Date.now(); q.setState.run(js, now, now, u.id); return send(res, 200, { ok: true, stateUpdated: now });
    }
    if (m === 'PUT' && p === '/api/me/consent') {
      const b = await readJson(req); const v = b.marketing === true ? 1 : 0;
      if (v !== u.marketing) { q.setMkt.run(v, u.id); q.log.run(u.id, 'marketing', v, TERMS_VERSION, MKT_TEXT, ip, ua(req), Date.now()); }
      return send(res, 200, { ok: true, marketing: !!v });
    }
    if (m === 'PUT' && p === '/api/me/password') {
      const b = await readJson(req);
      if (!checkPass(String(b.current || ''), u.pass_hash)) return fail(res, 403, 'Senha atual incorreta.');
      const np = String(b.next || ''); if (np.length < 8 || np.length > 200) return fail(res, 400, 'A nova senha precisa ter pelo menos 8 caracteres.');
      q.setPass.run(hashPass(np), u.id); return send(res, 200, { ok: true, token: newToken(q.byId.get(u.id)) });
    }
    if (m === 'GET' && p === '/api/me/export') {
      return send(res, 200, { exportadoEm: new Date().toISOString(), conta: publicUser(u), ultimoAcesso: u.last_seen, progresso: u.state ? JSON.parse(u.state) : null, consentimentos: q.logsOf.all(u.id) }, { 'Content-Disposition': 'attachment; filename="meus-dados-timoneiro.json"' });
    }
    if (m === 'DELETE' && p === '/api/me') {
      const b = await readJson(req);
      if (!checkPass(String(b.password || ''), u.pass_hash)) return fail(res, 403, 'Senha incorreta.');
      q.del.run(u.id); return send(res, 200, { ok: true });
    }
    return fail(res, 404, 'rota não encontrada');
  }

  // ----- rotas do mentor -----
  if (p.startsWith('/api/admin/')) {
    if (limited(ip, 'adm', 120)) return fail(res, 429, 'Muitas tentativas.');
    if (!isAdmin(req)) return fail(res, 401, 'Token de mentor inválido.');
    if (m === 'GET' && p === '/api/admin/students') {
      const rows = q.all.all().map((u) => ({ id: u.id, nome: u.name, email: u.email, criadoEm: u.created_at, ultimoAcesso: u.last_seen, aceitaMarketing: !!u.marketing, ...summary(u.state) }));
      return send(res, 200, { total: rows.length, alunos: rows });
    }
    if (m === 'GET' && p === '/api/admin/leads.csv') {
      const base = PUBLIC_URL || `https://${req.headers.host}`;
      const lines = [['nome', 'email', 'cadastro', 'link_descadastro'].map(csvCell).join(',')];
      for (const r of db.prepare('SELECT name,email,created_at,unsub_key FROM users WHERE marketing=1 ORDER BY created_at').all())
        lines.push([r.name, r.email, new Date(r.created_at).toISOString(), `${base}/api/unsubscribe?k=${r.unsub_key}`].map(csvCell).join(','));
      return send(res, 200, '﻿' + lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads-timoneiro.csv"' });
    }
    const mm = p.match(/^\/api\/admin\/students\/(\d+)\/reset-password$/);
    if (m === 'POST' && mm) {
      const u = q.byId.get(+mm[1]); if (!u) return fail(res, 404, 'Aluno não encontrado.');
      const temp = crypto.randomBytes(6).toString('base64url'); q.setPass.run(hashPass(temp), u.id);
      return send(res, 200, { senhaTemporaria: temp });
    }
    return fail(res, 404, 'rota não encontrada');
  }

  return fail(res, 404, 'não encontrado');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e && (e.code === 413 || e.code === 400)) return fail(res, e.code, e.code === 413 ? 'Requisição muito grande.' : 'JSON inválido.');
    console.error(e); if (!res.headersSent) fail(res, 500, 'Erro interno.');
  });
});
server.listen(PORT, () => console.log(`Timoneiro ouvindo na porta ${PORT}`));
const stop = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
