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
// E-mails de contas que também são administradoras (separados por vírgula)
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const CONFIG = {
  mentoriaUrl: process.env.MENTORIA_URL || '',
  lojaUrl: process.env.LOJA_URL || '',
  ebookUrl: process.env.EBOOK_URL || '',
  ebookTitle: process.env.EBOOK_TITLE || 'Do Zero ao DevOps com AIOps',
  mentorWhatsapp: String(process.env.MENTOR_WHATSAPP || '').replace(/\D/g, ''),
  contato: process.env.CONTATO_EMAIL || '',
};
// Versão e texto exatos dos consentimentos (guardados no log a cada aceite)
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-11-16';
const TERMS_TEXT = 'Li e aceito os Termos de Uso e a Política de Privacidade.';
const WA_TEXT = 'Quero receber no WhatsApp o plantão do dia, novidades da mentoria e lançamentos das camisetas. Posso cancelar quando quiser.';
const PHONE_NOTICE = 'O WhatsApp é obrigatório para criar sua conta. Ele identifica sua conta e é usado para falar com você sobre seu acesso e seu progresso no Timoneiro. Promoções só chegam se você marcar a opção de ofertas.';
const AREAS = ['SRE', 'DevOps', 'AIOps / MLOps', 'Platform Engineering', 'Cloud', 'Desenvolvimento', 'QA / Testes', 'Segurança', 'Dados', 'PO / PM', 'Agile / Scrum', 'Infra / Suporte', 'Estudante', 'Outra'];
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
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_user ON events(user_id);
CREATE TABLE IF NOT EXISTS certificates(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS xp_week(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, week)
);
`);
{ // migração: novas colunas sem perder dados
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  if (!cols.includes('whatsapp')) db.exec('ALTER TABLE users ADD COLUMN whatsapp INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('area')) db.exec('ALTER TABLE users ADD COLUMN area TEXT');
  if (!cols.includes('ranking')) db.exec('ALTER TABLE users ADD COLUMN ranking INTEGER NOT NULL DEFAULT 1');
}
const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email=?'),
  byId: db.prepare('SELECT * FROM users WHERE id=?'),
  byUnsub: db.prepare('SELECT * FROM users WHERE unsub_key=?'),
  insert: db.prepare('INSERT INTO users(name,email,pass_hash,created_at,last_seen,marketing,terms_version,unsub_key) VALUES(?,?,?,?,?,?,?,?)'),
  seen: db.prepare('UPDATE users SET last_seen=? WHERE id=?'),
  setState: db.prepare('UPDATE users SET state=?, state_updated=?, last_seen=? WHERE id=?'),
  setMkt: db.prepare('UPDATE users SET marketing=? WHERE id=?'),
  setWa: db.prepare('UPDATE users SET whatsapp=? WHERE id=?'),
  setProfile: db.prepare('UPDATE users SET phone=?, area=? WHERE id=?'),
  setPass: db.prepare('UPDATE users SET pass_hash=? WHERE id=?'),
  del: db.prepare('DELETE FROM users WHERE id=?'),
  event: db.prepare('INSERT INTO events(user_id,kind,at) VALUES(?,?,?)'),
  clicks: db.prepare('SELECT user_id, kind, COUNT(*) n, MAX(at) last FROM events GROUP BY user_id, kind'),
  certOf: db.prepare('SELECT * FROM certificates WHERE user_id=?'),
  certById: db.prepare('SELECT c.*, u.state FROM certificates c JOIN users u ON u.id=c.user_id WHERE c.id=?'),
  certNew: db.prepare('INSERT INTO certificates(id,user_id,name,issued_at) VALUES(?,?,?,?)'),
  xpAdd: db.prepare('INSERT INTO xp_week(user_id,week,xp) VALUES(?,?,?) ON CONFLICT(user_id,week) DO UPDATE SET xp=xp+excluded.xp'),
  top: db.prepare('SELECT u.id, u.name, u.state, w.xp FROM xp_week w JOIN users u ON u.id=w.user_id WHERE w.week=? AND u.ranking=1 AND w.xp>0 ORDER BY w.xp DESC, u.id ASC LIMIT 10'),
  myWeek: db.prepare('SELECT xp FROM xp_week WHERE user_id=? AND week=?'),
  above: db.prepare('SELECT COUNT(*) n FROM xp_week w JOIN users u ON u.id=w.user_id WHERE w.week=? AND u.ranking=1 AND w.xp>?'),
  setRanking: db.prepare('UPDATE users SET ranking=? WHERE id=?'),
  log: db.prepare('INSERT INTO consent_log(user_id,kind,granted,text_version,text,ip,ua,at) VALUES(?,?,?,?,?,?,?,?)'),
  logsOf: db.prepare('SELECT kind,granted,text_version,text,ip,at FROM consent_log WHERE user_id=? ORDER BY at'),
  all: db.prepare('SELECT id,name,email,phone,area,whatsapp,created_at,last_seen,marketing,state,state_updated FROM users ORDER BY last_seen DESC'),
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
const isAdminUser = (u) => !!u && ADMIN_EMAILS.includes(String(u.email).toLowerCase());
const isAdmin = (req) => {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Admin ')) return safeEq(h.slice(6), ADMIN_TOKEN);
  if (h.startsWith('Bearer ')) return isAdminUser(authUser(req));
  return false;
};
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', area: u.area || '', marketing: !!u.marketing, whatsapp: !!u.whatsapp, ranking: u.ranking !== 0, isAdmin: isAdminUser(u), createdAt: u.created_at });
// Telefone BR: guarda só dígitos com DDI 55 (ex.: 5519999998888). Vazio = sem telefone.
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
  return /^55\d{10,11}$/.test(d) ? d : null;
}
// Semana começa segunda 00:00 no horário de Brasília (UTC-3); a chave é a data da segunda-feira
function weekKey(t = Date.now()) {
  const d = new Date(t - 3 * 3600e3); const dow = (d.getUTCDay() + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return mon.toISOString().slice(0, 10);
}
const weekEnd = (key) => Date.parse(key + 'T00:00:00Z') + 7 * 864e5 + 3 * 3600e3;
const shortName = (n) => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };
const stateOf = (js) => { try { return JSON.parse(js || '{}') || {}; } catch { return {}; } };
const ROUTE = []; for (let i = 0; i < 12; i++) ROUTE.push(i + 'l', i + 'b');
const routeDone = (st) => ROUTE.every((k) => st.done && st.done[k]);
const certId = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const b of crypto.randomBytes(10)) s += A[b % A.length]; return 'TIM-' + s.slice(0, 5) + '-' + s.slice(5); };
const normArea = (v) => (AREAS.includes(String(v || '')) ? String(v) : '');
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

// ---------- página pública do certificado ----------
function certPage(res, c, req) {
  const base = PUBLIC_URL || `https://${req.headers.host}`;
  const e = (v) => String(v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  if (!c) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS }); return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;background:#050b1a;color:#eaf2ff;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h1>Certificado não encontrado</h1><p><a style="color:#3fe0ff" href="/">Conhecer o Timoneiro</a></p></div>'); }
  const st = stateOf(c.state), stars = Object.values(st.stars || {}).reduce((a, b) => a + (b | 0), 0);
  const dt = new Date(c.issued_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
  const title = `Certificado Timoneiro — ${e(c.name)}`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...SEC_HEADERS });
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<meta property="og:title" content="${title}"><meta property="og:description" content="${e(c.name)} concluiu a Rota Kubernetes do Timoneiro, jogo criado por Eduardo Lorente de Oliveira."><meta property="og:url" content="${e(base)}/c/${c.id}"><link rel="icon" href="/favicon.svg">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 0,#12305a,#050b1a 70%);font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#eaf2ff;padding:24px;box-sizing:border-box}
.c{max-width:760px;width:100%;border:2px solid #f6c453;border-radius:18px;padding:36px 28px;text-align:center;background:rgba(8,18,40,.85);box-shadow:0 0 0 6px rgba(246,196,83,.15),0 30px 60px rgba(0,0,0,.5)}
.k{letter-spacing:4px;font-size:13px;color:#3fe0ff}.t{font-size:15px;letter-spacing:3px;color:#f6c453;margin-top:14px}.n{font-size:40px;font-weight:800;margin:14px 0 6px}
.d{color:#b9c6e0;line-height:1.5;max-width:560px;margin:10px auto}.m{display:flex;justify-content:center;gap:28px;flex-wrap:wrap;margin:22px 0;color:#b9c6e0;font-size:14px}.m b{display:block;color:#fff;font-size:18px}
.s{margin-top:22px;padding-top:16px;border-top:1px solid rgba(246,196,83,.35);color:#b9c6e0;font-size:14px}.s b{color:#fff}.ok{display:inline-block;margin-top:16px;padding:6px 14px;border-radius:20px;background:rgba(74,222,128,.15);color:#86efac;border:1px solid rgba(74,222,128,.5);font-size:13px}a{color:#3fe0ff}</style></head>
<body><div class="c"><div style="font-size:44px">☸</div><div class="k">TIMONEIRO</div><div class="t">CERTIFICADO DE CONCLUSÃO</div>
<div class="n">${e(c.name)}</div><div class="d">concluiu a <b>Rota Kubernetes</b> do Timoneiro: 12 ilhas e 12 tempestades, de Pods e Deployments a Ingress, RBAC, Helm e GitOps com ArgoCD.</div>
<div class="m"><div><b>${dt}</b>Emitido em</div><div><b>★ ${stars}/72</b>Estrelas</div><div><b>${e(c.id)}</b>Código</div></div>
<div class="ok">✓ Certificado verificado</div>
<div class="s">Timoneiro · criado por <b>Eduardo Lorente de Oliveira</b> · <a href="/">Jogar o Timoneiro</a></div></div></body></html>`);
}

// ---------- rotas ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const ip = clientIp(req);

  if (m === 'GET' && STATIC[p]) return serveStatic(res, STATIC[p]);
  if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
  if (m === 'GET' && p === '/api/config') return send(res, 200, { ...CONFIG, termsVersion: TERMS_VERSION, termsText: TERMS_TEXT, marketingText: MKT_TEXT, whatsappText: WA_TEXT, phoneNotice: PHONE_NOTICE, areas: AREAS });

  if (m === 'GET' && p === '/api/ranking') {
    const wk = weekKey(), me = authUser(req);
    const top = q.top.all(wk).map((r, i) => ({ pos: i + 1, nome: shortName(r.name), xp: r.xp, xpTotal: stateOf(r.state).xp | 0, eu: !!me && me.id === r.id }));
    let mine = null;
    if (me) { const w = q.myWeek.get(me.id, wk); const xp = w ? w.xp : 0; mine = { xp, pos: xp > 0 && me.ranking !== 0 ? q.above.get(wk, xp).n + 1 : null, visivel: me.ranking !== 0 }; }
    return send(res, 200, { semana: wk, terminaEm: weekEnd(wk), top, eu: mine });
  }
  const cm = p.match(/^\/c\/(TIM-[A-Z0-9]{5}-[A-Z0-9]{5})$/);
  if (m === 'GET' && cm) return certPage(res, q.certById.get(cm[1]), req);

  if (m === 'POST' && p === '/api/register') {
    if (limited(ip, 'reg', 10)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (name.length < 2) return fail(res, 400, 'Informe seu nome.');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'E-mail inválido.');
    if (pw.length < 8 || pw.length > 200) return fail(res, 400, 'A senha precisa ter pelo menos 8 caracteres.');
    if (b.terms !== true) return fail(res, 400, 'É preciso aceitar os Termos e a Política de Privacidade.');
    const phone = normPhone(b.phone), area = normArea(b.area), wa = b.whatsapp === true ? 1 : 0;
    if (phone === null) return fail(res, 400, 'Telefone inválido. Use DDD + número, ex.: (19) 99999-8888.');
    if (!phone) return fail(res, 400, 'Informe seu WhatsApp com DDD para criar a conta.');
    if (q.byEmail.get(email)) return fail(res, 409, 'Este e-mail já tem conta. Use "Entrar".');
    const now = Date.now(), mkt = b.marketing === true ? 1 : 0;
    const r = q.insert.run(name, email, hashPass(pw), now, now, mkt, TERMS_VERSION, crypto.randomBytes(18).toString('base64url'));
    const uid = Number(r.lastInsertRowid);
    q.log.run(uid, 'terms', 1, TERMS_VERSION, TERMS_TEXT, ip, ua(req), now);
    q.log.run(uid, 'marketing', mkt, TERMS_VERSION, MKT_TEXT, ip, ua(req), now);
    q.setProfile.run(phone || null, area || null, uid); q.setWa.run(wa, uid);
    q.log.run(uid, 'whatsapp', wa, TERMS_VERSION, WA_TEXT, ip, ua(req), now);
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
      const now = Date.now();
      const delta = Math.max(0, Math.min(500, (b.state.xp | 0) - (stateOf(u.state).xp | 0)));
      q.setState.run(js, now, now, u.id);
      if (delta > 0) q.xpAdd.run(u.id, weekKey(now), delta);
      return send(res, 200, { ok: true, stateUpdated: now });
    }
    if (m === 'PUT' && p === '/api/me/consent') {
      const b = await readJson(req);
      if (typeof b.marketing === 'boolean') { const v = b.marketing ? 1 : 0; if (v !== u.marketing) { q.setMkt.run(v, u.id); q.log.run(u.id, 'marketing', v, TERMS_VERSION, MKT_TEXT, ip, ua(req), Date.now()); } }
      if (typeof b.whatsapp === 'boolean') { const v = b.whatsapp ? 1 : 0; if (v && !u.phone) return fail(res, 400, 'Cadastre seu telefone antes de ativar o WhatsApp.'); if (v !== u.whatsapp) { q.setWa.run(v, u.id); q.log.run(u.id, 'whatsapp', v, TERMS_VERSION, WA_TEXT, ip, ua(req), Date.now()); } }
      return send(res, 200, { ok: true, user: publicUser(q.byId.get(u.id)) });
    }
    if (m === 'GET' && p === '/api/me/certificate') {
      const c = q.certOf.get(u.id); return send(res, 200, { certificate: c ? { id: c.id, name: c.name, issuedAt: c.issued_at } : null });
    }
    if (m === 'POST' && p === '/api/me/certificate') {
      const ex = q.certOf.get(u.id);
      if (ex) return send(res, 200, { certificate: { id: ex.id, name: ex.name, issuedAt: ex.issued_at } });
      if (!routeDone(stateOf(u.state))) return fail(res, 403, 'Complete as 12 ilhas e as 12 tempestades para receber o certificado.');
      const id = certId(), now = Date.now(); q.certNew.run(id, u.id, u.name, now);
      return send(res, 201, { certificate: { id, name: u.name, issuedAt: now } });
    }
    if (m === 'POST' && p === '/api/me/event') {
      const b = await readJson(req); const kind = String(b.kind || '');
      if (!['ebook', 'loja', 'mentoria', 'mentor'].includes(kind)) return fail(res, 400, 'Evento inválido.');
      if (limited(ip, 'evt', 120)) return send(res, 200, { ok: true });
      q.event.run(u.id, kind, Date.now()); return send(res, 200, { ok: true });
    }
    if (m === 'PUT' && p === '/api/me/profile') {
      const b = await readJson(req);
      if (typeof b.ranking === 'boolean' && b.phone === undefined) { q.setRanking.run(b.ranking ? 1 : 0, u.id); return send(res, 200, { ok: true, user: publicUser(q.byId.get(u.id)) }); }
      const phone = normPhone(b.phone), area = normArea(b.area);
      if (phone === null) return fail(res, 400, 'Telefone inválido. Use DDD + número, ex.: (19) 99999-8888.');
      if (!phone) return fail(res, 400, 'O WhatsApp é obrigatório na sua conta.');
      q.setProfile.run(phone || null, area || null, u.id);
      if (!phone && u.whatsapp) { q.setWa.run(0, u.id); q.log.run(u.id, 'whatsapp', 0, TERMS_VERSION, 'Telefone removido pelo titular', ip, ua(req), Date.now()); }
      return send(res, 200, { ok: true, user: publicUser(q.byId.get(u.id)) });
    }
    if (m === 'PUT' && p === '/api/me/password') {
      const b = await readJson(req);
      if (!checkPass(String(b.current || ''), u.pass_hash)) return fail(res, 403, 'Senha atual incorreta.');
      const np = String(b.next || ''); if (np.length < 8 || np.length > 200) return fail(res, 400, 'A nova senha precisa ter pelo menos 8 caracteres.');
      q.setPass.run(hashPass(np), u.id); return send(res, 200, { ok: true, token: newToken(q.byId.get(u.id)) });
    }
    if (m === 'GET' && p === '/api/me/export') {
      return send(res, 200, { exportadoEm: new Date().toISOString(), conta: publicUser(u), ultimoAcesso: u.last_seen, progresso: u.state ? JSON.parse(u.state) : null, consentimentos: q.logsOf.all(u.id), cliques: db.prepare('SELECT kind, at FROM events WHERE user_id=? ORDER BY at').all(u.id), certificado: q.certOf.get(u.id) || null, xpSemanal: db.prepare('SELECT week, xp FROM xp_week WHERE user_id=? ORDER BY week').all(u.id) }, { 'Content-Disposition': 'attachment; filename="meus-dados-timoneiro.json"' });
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
      const ck = {}; for (const c of q.clicks.all()) { (ck[c.user_id] = ck[c.user_id] || {})[c.kind] = { n: c.n, ultimo: c.last }; }
      const rows = q.all.all().map((u) => ({ cliques: ck[u.id] || {}, id: u.id, nome: u.name, email: u.email, telefone: u.phone || '', area: u.area || '', criadoEm: u.created_at, ultimoAcesso: u.last_seen, aceitaMarketing: !!u.marketing, aceitaWhatsapp: !!(u.whatsapp && u.phone), ...summary(u.state) }));
      return send(res, 200, { total: rows.length, alunos: rows });
    }
    if (m === 'GET' && p === '/api/admin/leads.csv') {
      const base = PUBLIC_URL || `https://${req.headers.host}`;
      const lines = [['nome', 'email', 'area', 'cadastro', 'link_descadastro'].map(csvCell).join(',')];
      for (const r of db.prepare('SELECT name,email,area,created_at,unsub_key FROM users WHERE marketing=1 ORDER BY created_at').all())
        lines.push([r.name, r.email, r.area || '', new Date(r.created_at).toISOString(), `${base}/api/unsubscribe?k=${r.unsub_key}`].map(csvCell).join(','));
      return send(res, 200, '﻿' + lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads-timoneiro.csv"' });
    }
    if (m === 'GET' && p === '/api/admin/whatsapp.csv') {
      const lines = [['nome', 'telefone', 'area', 'cadastro', 'link_whatsapp'].map(csvCell).join(',')];
      for (const r of db.prepare("SELECT name,phone,area,created_at FROM users WHERE whatsapp=1 AND phone IS NOT NULL AND phone<>'' ORDER BY created_at").all())
        lines.push([r.name, r.phone, r.area || '', new Date(r.created_at).toISOString(), `https://wa.me/${r.phone}`].map(csvCell).join(','));
      return send(res, 200, '\ufeff' + lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="whatsapp-timoneiro.csv"' });
    }
    const oo = p.match(/^\/api\/admin\/students\/(\d+)\/optout$/);
    if (m === 'POST' && oo) {
      const u = q.byId.get(+oo[1]); if (!u) return fail(res, 404, 'Aluno não encontrado.');
      const b = await readJson(req); const canal = b.canal === 'email' ? 'marketing' : 'whatsapp';
      if (canal === 'marketing' && u.marketing) { q.setMkt.run(0, u.id); q.log.run(u.id, 'marketing', 0, TERMS_VERSION, 'Descadastro pedido ao mentor', ip, ua(req), Date.now()); }
      if (canal === 'whatsapp' && u.whatsapp) { q.setWa.run(0, u.id); q.log.run(u.id, 'whatsapp', 0, TERMS_VERSION, 'Descadastro pedido ao mentor', ip, ua(req), Date.now()); }
      return send(res, 200, { ok: true });
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
