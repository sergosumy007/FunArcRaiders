// Player reports for the FunArcRaiders map: a small public API over D1.
// Reads are open and cached; writes need a captcha, an allowed origin and fall under daily limits.

const MAPS = new Set(['dam-battleground', 'the-spaceport', 'buried-city', 'blue-gate', 'stella-montis', 'riven-tides', 'pendola-pass']);
const FLOORED = new Set(['stella-montis']);
const KINDS = new Set(['item', 'bp', 'arc', 'quest', 'key', 'map']);
const VERDICT_KINDS = new Set(['item', 'bp', 'arc']);
const LANGS = new Set(['ru', 'pl', 'en']);
const ID_RE = /^[a-z0-9_\-/]{1,80}$/;
const DEVICE_RE = /^[a-f0-9]{32}$/;
const LINK_RE = /https?:|www\.|t\.me|@[a-z0-9_]{3,}|\.(com|ru|net|org|gg|io|pl|me|ua|su|xyz|ly)(\/|\s|$)/i;

const MAX_BODY = 4096;
const MIN_TIP = 3;
const MAX_TIP = 280;
const COOLDOWN = 15 * 60;
const CONFIRM_LIMIT = 4000;
const LIMITS = {
  report: { device: 60, ip: 200, all: 5000 },
  tip: { device: 8, ip: 30, all: 300 }
};

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers }
  });
}

function allowed(env, origin) {
  return !!origin && String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
}

// Only short keyed digests are stored, so raw IPs and browser tokens never reach the database.
async function digest(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function human(env, token, ip) {
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip });
  const res = await fetch(env.TURNSTILE_URL || TURNSTILE_URL, { method: 'POST', body });
  if (!res.ok) return false;
  const out = await res.json().catch(() => ({}));
  return out.success === true;
}

function parsePlace(b) {
  if (!MAPS.has(b.map) || !KINDS.has(b.kind)) return null;
  const item = b.kind === 'map' ? '-' : b.id;
  if (b.kind !== 'map' && (typeof item !== 'string' || !ID_RE.test(item))) return null;
  if (typeof b.x !== 'number' || typeof b.y !== 'number' || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  if (b.x < 0 || b.x > 1000 || b.y < 0 || b.y > 1000) return null;
  const legalFloor = FLOORED.has(b.map) ? b.floor === 0 || b.floor === 1 : b.floor === -1;
  if (!legalFloor) return null;
  return { map: b.map, floor: b.floor, kind: b.kind, item, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 };
}

function cleanTip(value) {
  if (typeof value !== 'string') return null;
  return value.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

async function bump(env, key, day, max) {
  const row = await env.DB.prepare(
    `INSERT INTO limits (k, day, n) VALUES (?1, ?2, 1)
     ON CONFLICT (k) DO UPDATE SET n = CASE WHEN limits.day = excluded.day THEN limits.n + 1 ELSE 1 END, day = excluded.day
     RETURNING n`
  ).bind(key, day).first();
  return row.n <= max;
}

async function withinLimits(env, kind, device, ipDay, day) {
  const cap = LIMITS[kind];
  const checks = await Promise.all([
    bump(env, `${kind}:d:${device}`, day, cap.device),
    bump(env, `${kind}:i:${ipDay}`, day, cap.ip),
    bump(env, `${kind}:all`, day, cap.all)
  ]);
  return checks.every(Boolean);
}

async function pointIdOf(env, p, t) {
  const row = await env.DB.prepare(
    `INSERT INTO points (map, floor, kind, item, x, y, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (map, floor, kind, item, x, y) DO UPDATE SET created = points.created
     RETURNING id`
  ).bind(p.map, p.floor, p.kind, p.item, p.x, p.y, t).first();
  return row.id;
}

// A player counts once whether they switch browsers or come back from another address.
function shape(row, tips) {
  const lastTip = tips.reduce((m, x) => Math.max(m, x.d), 0);
  return {
    id: row.id, f: row.f, k: row.k, i: row.i, x: row.x, y: row.y,
    found: row.found, empty: row.empty, pl: Math.min(row.d, row.ip),
    last: Math.max(row.last || 0, lastTip), tips
  };
}

const POINT_SELECT = `SELECT p.id, p.floor AS f, p.kind AS k, p.item AS i, p.x, p.y,
  COALESCE(SUM(r.verdict = 1), 0) AS found, COALESCE(SUM(r.verdict = 0), 0) AS empty,
  COUNT(DISTINCT r.device) AS d, COUNT(DISTINCT r.ip_day) AS ip, MAX(r.ts) AS last
  FROM points p LEFT JOIN reports r ON r.point = p.id`;

async function pointView(env, id) {
  const row = await env.DB.prepare(`${POINT_SELECT} WHERE p.id = ?1 AND p.hidden = 0 GROUP BY p.id`).bind(id).first();
  if (!row) return null;
  const tips = await env.DB.prepare('SELECT body AS t, lang AS l, ts AS d FROM tips WHERE point = ?1 AND status = 1 ORDER BY ts DESC LIMIT 30').bind(id).all();
  return shape(row, tips.results);
}

async function points(request, env, ctx, url) {
  const open = { 'Access-Control-Allow-Origin': '*' };
  const map = url.searchParams.get('map');
  if (!MAPS.has(map)) return json({ error: 'bad' }, 400, open);
  const ttl = Number(env.CACHE_SECONDS ?? 60);
  const key = new Request(`${url.origin}/v1/points?map=${map}`);
  if (ttl > 0) {
    const hit = await caches.default.match(key);
    if (hit) return hit;
  }
  const rows = await env.DB.prepare(`${POINT_SELECT} WHERE p.map = ?1 AND p.hidden = 0 GROUP BY p.id ORDER BY last DESC LIMIT ${CONFIRM_LIMIT}`).bind(map).all();
  const tips = await env.DB.prepare(
    `SELECT t.point, t.body AS t, t.lang AS l, t.ts AS d FROM tips t JOIN points p ON p.id = t.point
     WHERE p.map = ?1 AND p.hidden = 0 AND t.status = 1 ORDER BY t.ts DESC LIMIT 2000`
  ).bind(map).all();
  const byPoint = new Map();
  for (const t of tips.results) {
    if (!byPoint.has(t.point)) byPoint.set(t.point, []);
    byPoint.get(t.point).push({ t: t.t, l: t.l, d: t.d });
  }
  const pts = rows.results
    .map((r) => shape(r, byPoint.get(r.id) || []))
    .filter((p) => p.found + p.empty > 0 || p.tips.length > 0);
  const res = json({ pts }, 200, { ...open, 'cache-control': `public, max-age=${Math.min(ttl, 30)}, s-maxage=${ttl}` });
  if (ttl > 0) ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

async function tg(env, method, payload) {
  if (!env.TG_TOKEN) return null;
  const api = env.TG_API || 'https://api.telegram.org';
  const res = await fetch(`${api}/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  return res.ok ? res.json().catch(() => null) : null;
}

function tipButtons(id) {
  return { inline_keyboard: [[{ text: '✅ Оставить', callback_data: `ok:${id}` }, { text: '🗑 Удалить', callback_data: `no:${id}` }]] };
}

// Plain text on purpose: a player's words must never be parsed as Telegram markup.
function tipCard(id, p, body, lang) {
  return `Совет #${id}\nКарта: ${p.map}${p.floor >= 0 ? ` (этаж ${p.floor})` : ''}\nК чему: ${p.kind} ${p.item}\nЯзык: ${lang}\n\n${body}`;
}

async function notifyTip(env, id, place, body, lang) {
  if (!env.TG_ADMIN) return;
  await tg(env, 'sendMessage', { chat_id: env.TG_ADMIN, text: tipCard(id, place, body, lang), reply_markup: tipButtons(id) });
}

async function submit(request, env, ctx) {
  const origin = request.headers.get('Origin') || '';
  if (!allowed(env, origin)) return json({ error: 'origin' }, 403);
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const fail = (code, status) => json({ error: code }, status, cors);

  if (!env.SALT || !env.TURNSTILE_SECRET) return fail('closed', 503);
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return fail('bad', 415);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail('bad', 413);
  let body;
  try { body = JSON.parse(raw); } catch { return fail('bad', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad', 400);
  if (typeof body.device !== 'string' || !DEVICE_RE.test(body.device)) return fail('bad', 400);

  const place = parsePlace(body);
  if (!place) return fail('bad', 400);

  let verdict = null;
  if (body.verdict !== undefined && body.verdict !== null) {
    if (body.verdict !== 'found' && body.verdict !== 'empty') return fail('bad', 400);
    if (!VERDICT_KINDS.has(place.kind)) return fail('bad', 400);
    verdict = body.verdict === 'found' ? 1 : 0;
  }

  let tip = null;
  if (body.tip !== undefined && body.tip !== null && body.tip !== '') {
    tip = cleanTip(body.tip);
    if (tip === null || tip.length < MIN_TIP || tip.length > MAX_TIP) return fail('tip_len', 400);
    if (LINK_RE.test(tip)) return fail('tip_link', 400);
  }
  if (verdict === null && tip === null) return fail('bad', 400);
  const lang = LANGS.has(body.lang) ? body.lang : 'en';

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await human(env, body.token, ip))) return fail('captcha', 403);

  const t = now();
  const day = dayOf(t);
  const device = await digest(env.SALT, `d:${body.device}`);
  const ipDay = await digest(env.SALT, `i:${day}:${ip}`);

  if (verdict !== null && !(await withinLimits(env, 'report', device, ipDay, day))) return fail('limit', 429);
  if (tip !== null && !(await withinLimits(env, 'tip', device, ipDay, day))) return fail('limit', 429);
  if (Math.random() < 0.02) ctx.waitUntil(env.DB.prepare('DELETE FROM limits WHERE day < ?1').bind(day).run());

  const id = await pointIdOf(env, place, t);
  let dup = false;
  if (verdict !== null) {
    const seen = await env.DB.prepare('SELECT 1 FROM reports WHERE point = ?1 AND device = ?2 AND verdict = ?3 AND ts > ?4 LIMIT 1').bind(id, device, verdict, t - COOLDOWN).first();
    if (seen) dup = true;
    else await env.DB.prepare('INSERT INTO reports (point, verdict, device, ip_day, ts) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, verdict, device, ipDay, t).run();
  }
  if (tip !== null) {
    const row = await env.DB.prepare('INSERT INTO tips (point, body, lang, device, ts) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id').bind(id, tip, lang, device, t).first();
    ctx.waitUntil(notifyTip(env, row.id, place, tip, lang).catch(() => {}));
  }
  return json({ ok: true, dup, tip: tip !== null ? 'pending' : null, point: await pointView(env, id) }, 200, cors);
}

async function decide(env, q) {
  const m = /^(ok|no):(\d+)$/.exec(q.data || '');
  if (!m) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  const approve = m[1] === 'ok';
  const done = await env.DB.prepare('UPDATE tips SET status = ?1 WHERE id = ?2 AND status = 0').bind(approve ? 1 : 2, Number(m[2])).run();
  const label = done.meta.changes ? (approve ? '✅ Оставлен' : '🗑 Удалён') : 'Уже решено';
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: label });
  if (q.message) await tg(env, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${q.message.text || ''}\n\n${label}` });
}

async function command(env, text) {
  const reply = (body) => tg(env, 'sendMessage', { chat_id: env.TG_ADMIN, text: body });
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = parts[0].split('@')[0];
  if (cmd === '/stats') {
    const c = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM points) AS p, (SELECT COUNT(*) FROM points WHERE hidden = 1) AS h,
      (SELECT COUNT(*) FROM reports) AS r, (SELECT COUNT(*) FROM reports WHERE ts > ?1) AS d,
      (SELECT COUNT(*) FROM tips WHERE status = 0) AS w, (SELECT COUNT(*) FROM tips WHERE status = 1) AS a`).bind(now() - 86400).first();
    return reply(`Точек: ${c.p} (скрыто ${c.h})\nОтчётов: ${c.r} (за сутки ${c.d})\nСоветов: одобрено ${c.a}, ждут ${c.w}`);
  }
  if (cmd === '/pending') {
    const rows = await env.DB.prepare(`SELECT t.id, t.body, t.lang, p.map, p.floor, p.kind, p.item FROM tips t JOIN points p ON p.id = t.point WHERE t.status = 0 ORDER BY t.id LIMIT 10`).all();
    if (!rows.results.length) return reply('Советов на проверке нет');
    for (const r of rows.results) await tg(env, 'sendMessage', { chat_id: env.TG_ADMIN, text: tipCard(r.id, r, r.body, r.lang), reply_markup: tipButtons(r.id) });
    return null;
  }
  if ((cmd === '/hide' || cmd === '/show') && /^\d+$/.test(parts[1] || '')) {
    const done = await env.DB.prepare('UPDATE points SET hidden = ?1 WHERE id = ?2').bind(cmd === '/hide' ? 1 : 0, Number(parts[1])).run();
    return reply(done.meta.changes ? `Точка #${parts[1]}: ${cmd === '/hide' ? 'скрыта' : 'показана'}` : `Точки #${parts[1]} нет`);
  }
  return reply('Модерация FunArcRaiders\n/stats — сводка\n/pending — советы на проверке\n/hide N — скрыть точку (номер в карточке точки)\n/show N — вернуть точку');
}

async function hook(request, env) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_HOOK) return json({ error: 'forbidden' }, 403);
  const update = await request.json().catch(() => null);
  const admin = String(env.TG_ADMIN || '');
  if (update && admin) {
    if (update.callback_query && String(update.callback_query.from && update.callback_query.from.id) === admin) await decide(env, update.callback_query);
    else if (update.message && String(update.message.from && update.message.from.id) === admin) await command(env, update.message.text);
  }
  return json({ ok: true });
}

function preflight(env, request, methods, wide) {
  const origin = request.headers.get('Origin') || '';
  if (!wide && !allowed(env, origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': wide ? '*' : origin,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    }
  });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/v1/points') {
    if (request.method === 'OPTIONS') return preflight(env, request, 'GET', true);
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    return points(request, env, ctx, url);
  }
  if (url.pathname === '/v1/submit') {
    if (request.method === 'OPTIONS') return preflight(env, request, 'POST', false);
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    return submit(request, env, ctx);
  }
  if (env.TG_HOOK && url.pathname === `/tg/${env.TG_HOOK}` && request.method === 'POST') return hook(request, env);
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error('request failed', err && err.message);
      return json({ error: 'server' }, 500, { 'Access-Control-Allow-Origin': '*' });
    }
  }
};
