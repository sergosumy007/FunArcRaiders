// End-to-end checks against a local Worker with a local D1 and stubbed Telegram and captcha.
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799, STUB = 8798, HOOK = 'testhooksecret', ADMIN = '111';
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://sergosumy007.github.io';
const STATE = path.join(ROOT, '.wrangler', 'test-state');

const sent = [];
const stub = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/captcha')) {
      res.end(JSON.stringify({ success: new URLSearchParams(data).get('response') === 'good' }));
      return;
    }
    sent.push({ url: req.url, body: JSON.parse(data || '{}') });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});

const vars = [
  `SALT=test-salt`, `TURNSTILE_SECRET=test`, `TURNSTILE_URL=http://127.0.0.1:${STUB}/captcha`,
  `TG_TOKEN=T`, `TG_API=http://127.0.0.1:${STUB}`, `TG_ADMIN=${ADMIN}`, `TG_HOOK=${HOOK}`, `CACHE_SECONDS=0`,
  `ALLOWED_ORIGINS=${ORIGIN}`
].join('\n');

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) passed++;
  else { failed++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

const dev = () => 'a'.repeat(31) + String(Math.floor(Math.random() * 10));
const hex = (n) => n.toString(16).padStart(32, '0');
const place = { map: 'blue-gate', floor: -1, kind: 'item', id: 'mask_fragment', x: 100.5, y: 200.5 };

async function post(body, { origin = ORIGIN, ip = '10.0.0.1', type = 'application/json', raw } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (type) headers['Content-Type'] = type;
  if (origin) headers.Origin = origin;
  const res = await fetch(`${BASE}/v1/submit`, { method: 'POST', headers, body: raw !== undefined ? raw : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
const good = (extra) => ({ ...place, token: 'good', device: hex(1), lang: 'ru', ...extra });
const list = async (map = 'blue-gate') => (await (await fetch(`${BASE}/v1/points?map=${map}`)).json()).pts;
const update = (u, secret = HOOK) => fetch(`${BASE}/tg/${HOOK}`, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'content-type': 'application/json' }, body: JSON.stringify(u) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  let r = await fetch(`${BASE}/v1/points?map=nope`);
  check('unknown map refused', r.status === 400);
  r = await fetch(`${BASE}/v1/points?map=blue-gate`);
  check('read works and is open', r.status === 200 && r.headers.get('access-control-allow-origin') === '*');

  check('no origin', (await post(good(), { origin: '' })).status === 403);
  check('foreign origin', (await post(good(), { origin: 'https://evil.example' })).status === 403);
  check('prefix origin', (await post(good(), { origin: ORIGIN + '.evil.example' })).status === 403);
  check('wrong content type', (await post(good(), { type: 'text/plain' })).status === 415);
  check('oversized', (await post(null, { raw: JSON.stringify(good({ pad: 'x'.repeat(5000) })) })).status === 413);
  check('broken json', (await post(null, { raw: '{oops' })).status === 400);
  check('array body', (await post(null, { raw: '[1,2]' })).status === 400);

  const bad = {
    'x too big': { x: 1000.1 }, 'x negative': { x: -1 }, 'x string': { x: '5' }, 'y null': { y: null },
    'unknown map': { map: 'moon' }, 'unknown kind': { kind: 'admin' }, 'injected id': { id: "x' OR 1=1 --" },
    'upper id': { id: 'ABC' }, 'floor on flat map': { floor: 0 }, 'bad device': { device: 'zz' },
    'proto verdict': { verdict: 'constructor' }, 'no content': { verdict: undefined, tip: undefined },
    'verdict on quest': { kind: 'quest', id: 'q1', verdict: 'found' }
  };
  for (const [name, patch] of Object.entries(bad)) {
    const res = await post({ verdict: 'found', ...good(patch) , ...patch });
    check(`rejected: ${name}`, res.status === 400 && res.body.error === 'bad', res.body);
  }
  check('floor required on tiered map', (await post({ verdict: 'found', ...good({ map: 'stella-montis', floor: -1 }) })).status === 400);
  check('tiered map accepts floor', (await post({ verdict: 'found', ...good({ map: 'stella-montis', floor: 1 }) })).status === 200);

  check('captcha refused', (await post({ verdict: 'found', ...good({ token: 'nope' }) })).body.error === 'captcha');
  check('captcha missing', (await post({ verdict: 'found', ...good({ token: undefined }) })).body.error === 'captcha');
  check('nothing stored after refusals', (await list()).length === 0, await list());

  let res = await post({ verdict: 'found', ...good() });
  check('first report', res.status === 200 && res.body.point.found === 1 && res.body.point.pl === 1, res.body);
  check('cors echoes origin', res.headers.get('access-control-allow-origin') === ORIGIN);
  const pid = res.body.point.id;
  res = await post({ verdict: 'found', ...good() });
  check('double click ignored', res.body.dup === true && res.body.point.found === 1, res.body);
  res = await post({ verdict: 'empty', ...good() });
  check('empty counted separately', res.body.point.found === 1 && res.body.point.empty === 1, res.body);

  await post({ verdict: 'found', ...good({ device: hex(9), x: 150.5 }) }, { ip: '10.0.0.9' });
  res = await post({ verdict: 'empty', ...good({ device: hex(9), x: 150.5 }) }, { ip: '10.0.0.10' });
  check('same browser from another address is one player', res.body.dup === false && res.body.point.empty === 1 && res.body.point.found === 1 && res.body.point.pl === 1, res.body);
  res = await post({ verdict: 'found', ...good({ device: hex(2) }) }, { ip: '10.0.0.1' });
  check('new browser from same address is one player', res.body.point.pl === 1, res.body);
  res = await post({ verdict: 'found', ...good({ device: hex(3) }) }, { ip: '10.0.0.3' });
  check('different browser and address adds a player', res.body.point.pl === 2, res.body);
  res = await post({ verdict: 'found', ...good({ device: hex(4) }) }, { ip: '10.0.0.4' });
  check('third player', res.body.point.pl === 3 && res.body.point.found === 4, res.body);

  check('long tip', (await post({ ...good({ tip: 'x'.repeat(281) }) })).body.error === 'tip_len');
  check('short tip', (await post({ ...good({ tip: 'ab' }) })).body.error === 'tip_len');
  check('non-string tip', (await post({ ...good({ tip: 12345 }) })).body.error === 'tip_len');
  for (const link of ['см http://x.co', 'www.spam.net тут', 't.me/spam', 'пиши @spammer', 'заходи spam.ru сейчас']) {
    check(`link refused: ${link}`, (await post({ ...good({ tip: link, device: hex(5) }) })).body.error === 'tip_link');
  }

  const evil = `<img src=x onerror=alert(1)> '; DROP TABLE tips; --`;
  sent.length = 0;
  res = await post({ ...good({ tip: evil, device: hex(6), x: 300, y: 300 }) }, { ip: '10.0.0.6' });
  check('tip accepted as pending', res.status === 200 && res.body.tip === 'pending', res.body);
  check('pending tip hidden from reader response', res.body.point === null || res.body.point.tips.length === 0, res.body);
  check('pending-only point hidden from list', !(await list()).some((p) => p.x === 300), await list());
  for (let i = 0; i < 20 && !sent.length; i++) await sleep(100);
  check('moderator notified', sent.length === 1 && sent[0].url === '/botT/sendMessage', sent);
  check('card is plain text', sent[0] && sent[0].body.parse_mode === undefined && sent[0].body.text.includes(evil), sent[0]);
  const tipId = Number(sent[0].body.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1]);

  r = await fetch(`${BASE}/tg/${HOOK}`, { method: 'POST', body: '{}' });
  check('webhook needs its secret', r.status === 403);
  r = await update({}, 'wrong');
  check('webhook refuses a wrong secret', r.status === 403);
  r = await fetch(`${BASE}/tg/wrongpath`, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': HOOK }, body: '{}' });
  check('wrong hook path', r.status === 404);
  await update({ callback_query: { id: 'q', from: { id: 999 }, data: `ok:${tipId}`, message: { chat: { id: 999 }, message_id: 1, text: 'x' } } });
  check('stranger cannot approve', !(await list()).some((p) => p.x === 300));
  await update({ message: { from: { id: 999 }, text: `/hide ${pid}` } });
  check('stranger cannot hide', (await list()).some((p) => p.id === pid));

  await update({ callback_query: { id: 'q', from: { id: Number(ADMIN) }, data: `ok:${tipId}`, message: { chat: { id: Number(ADMIN) }, message_id: 1, text: 'card' } } });
  const shown = (await list()).find((p) => p.x === 300);
  check('approved tip is shown', shown && shown.tips.length === 1 && shown.tips[0].t.includes('DROP TABLE'), shown);
  check('tips table survived', (await list()).some((p) => p.x === 300));

  await update({ message: { from: { id: Number(ADMIN) }, text: `/hide ${pid}` } });
  check('admin hides a point', !(await list()).some((p) => p.id === pid));
  await update({ message: { from: { id: Number(ADMIN) }, text: `/show ${pid}` } });
  check('admin restores a point', (await list()).some((p) => p.id === pid));
  sent.length = 0;
  await update({ message: { from: { id: Number(ADMIN) }, text: '/stats' } });
  check('stats answer', sent.length === 1 && /Точек: /.test(sent[0].body.text), sent);

  let refused = 0;
  for (let i = 0; i < 62; i++) {
    const out = await post({ verdict: 'found', ...good({ device: hex(77), x: 500 + i, y: 500 }) }, { ip: '10.0.0.77' });
    if (out.status === 429) refused++;
  }
  check('daily limit stops one browser', refused === 2, refused);

  let tips = 0;
  for (let i = 0; i < 10; i++) {
    const out = await post({ ...good({ device: hex(88), tip: `совет номер ${i}`, x: 700 + i, y: 700 }) }, { ip: '10.0.0.88' });
    if (out.status === 429) tips++;
  }
  check('tip limit', tips === 2, tips);

  const db = fs.readdirSync(STATE, { recursive: true }).map(String).filter((f) => f.endsWith('.sqlite'));
  check('local database exists', db.length > 0);
  const dump = db.map((f) => fs.readFileSync(path.join(STATE, f)).toString('latin1')).join('');
  check('no raw addresses stored', !dump.includes('10.0.0.1') && !dump.includes('10.0.0.77'));
  check('no raw browser tokens stored', !dump.includes(hex(77)));
}

async function main() {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.writeFileSync(path.join(ROOT, '.dev.vars'), vars);
  await new Promise((ok) => stub.listen(STUB, '127.0.0.1', ok));
  execSync(`npx --no-install wrangler d1 migrations apply DB --local --persist-to .wrangler/test-state`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  const worker = spawn(`npx --no-install wrangler dev --local --port ${PORT} --persist-to .wrangler/test-state --log-level error`, { cwd: ROOT, shell: true, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      up = await fetch(`${BASE}/v1/points?map=blue-gate`).then((x) => x.status === 200).catch(() => false);
    }
    if (!up) throw new Error('worker did not start');
    await run();
  } finally {
    if (process.platform === 'win32') { try { execSync(`taskkill /pid ${worker.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ } }
    else worker.kill();
    stub.close();
    fs.rmSync(path.join(ROOT, '.dev.vars'), { force: true });
  }
  console.log(`passed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
