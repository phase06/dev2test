// Remote-runtime hardening: tokens out of URLs, origin allowlist, TLS, and API keys at rest.
// Run `npm run build:runtime` first.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-provider.mjs';

const RUNTIME = new URL('../dist/crew-runtime.mjs', import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-hard-'));
const kids = new Set();
const mock = await startMock();
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  for (const k of kids) k.kill();
  mock.close();
  await sleep(200);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start a runtime; resolves { port, token, stderr } when ready, or { code, stderr } if it exits first. */
function start(name, args = [], env = {}) {
  const home = path.join(tmp, name);
  const child = fork(RUNTIME, ['--port', '0', ...args], { env: { ...process.env, CREW_HOME: home, ...env }, silent: true });
  kids.add(child);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', () => {});
  return new Promise((resolve) => {
    child.on('message', (m) => m.ready && resolve({ child, home, port: m.port, token: m.token, stderr: () => stderr }));
    child.on('exit', (code) => (kids.delete(child), resolve({ code, stderr: () => stderr })));
  });
}
const stop = async (rt) => {
  const exited = new Promise((r) => rt.child.on('exit', r));
  rt.child.kill();
  await exited;
};
const call = (rt, method, p, { body, headers = {}, auth = true } = {}) =>
  fetch(`http://127.0.0.1:${rt.port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${rt.token}` } : {}), ...headers },
    body: body && JSON.stringify(body),
  });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

const rt = await start('main');
const bot = await (await call(rt, 'POST', '/api/bots', { body: { name: 'Ada', isolation: 'host' } })).json();
fs.writeFileSync(path.join(rt.home, 'workspaces', bot.id, 'note.txt'), 'hello');

test('the access token is not accepted in a URL', async () => {
  const r = await call(rt, 'GET', `/api/bots?token=${rt.token}`, { auth: false });
  assert.equal(r.status, 401);
});

test('tickets open only the event stream and workspace files, read-only', async () => {
  const { body: t } = await json(await call(rt, 'POST', '/api/ticket'));
  assert.match(t.ticket, /^\d+\.[\w-]+$/);
  assert.ok(t.expires - Date.now() > 14 * 60_000 && t.expires - Date.now() <= 15 * 60_000);
  const q = `ticket=${encodeURIComponent(t.ticket)}`;
  const file = await call(rt, 'GET', `/api/bots/${bot.id}/file?path=note.txt&${q}`, { auth: false });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'hello');
  assert.equal((await call(rt, 'GET', `/api/bots?${q}`, { auth: false })).status, 401, 'not other endpoints');
  assert.equal((await call(rt, 'GET', `/api/config?${q}`, { auth: false })).status, 401);
  assert.equal((await call(rt, 'POST', `/api/ticket?${q}`, { auth: false })).status, 401, 'cannot mint more tickets');
  const [exp, mac] = t.ticket.split('.');
  const forged = `${Number(exp) + 3600_000}.${mac}`;
  assert.equal((await call(rt, 'GET', `/api/bots/${bot.id}/file?path=note.txt&ticket=${forged}`, { auth: false })).status, 401, 'expiry is signed');
  // The event stream accepts a ticket.
  const ac = new AbortController();
  const ev = await fetch(`http://127.0.0.1:${rt.port}/api/events?${q}`, { signal: ac.signal });
  assert.equal(ev.status, 200);
  assert.match(ev.headers.get('content-type'), /text\/event-stream/);
  ac.abort();
});

test('tickets stop working after a restart', async () => {
  const other = await start('restart');
  const { body: t } = await json(await call(other, 'POST', '/api/ticket'));
  await stop(other);
  const again = await start('restart');
  assert.equal((await call(again, 'GET', `/api/events?ticket=${encodeURIComponent(t.ticket)}`, { auth: false })).status, 401);
  await stop(again);
});

test('browser origins: own, loopback and configured origins only', async () => {
  const evil = await call(rt, 'GET', '/api/info', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const local = await call(rt, 'GET', '/api/info', { headers: { origin: 'http://127.0.0.1:4780' } });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4780');
  const preflight = await fetch(`http://127.0.0.1:${rt.port}/api/info`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(preflight.status, 403);
  // No Origin header (curl, the eval runner, other runtimes' servers): unaffected.
  assert.equal((await call(rt, 'GET', '/api/info')).status, 200);

  const cfg = await start('origins', ['--allow-origin', 'https://crew.example.com/']);
  const ok = await call(cfg, 'GET', '/api/info', { headers: { origin: 'https://crew.example.com' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await (await call(cfg, 'GET', '/api/config')).json()).allowedOrigins, ['https://crew.example.com']);
  await stop(cfg);
});

test('static pages refuse framing and the API sends no referrer', async () => {
  const page = await fetch(`http://127.0.0.1:${rt.port}/`);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
});

test('plain HTTP on a non-loopback address is refused unless explicitly allowed', async () => {
  const refused = await start('public', ['--host', '0.0.0.0']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr(), /Refusing to serve plain HTTP on 0\.0\.0\.0/);
  const allowed = await start('public2', ['--host', '0.0.0.0', '--allow-insecure-http']);
  assert.ok(allowed.port, allowed.stderr?.());
  await stop(allowed);
});

test('built-in HTTPS', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const tls = await start('tls', ['--host', '0.0.0.0', '--tls-cert', path.join(dir, 'cert.pem'), '--tls-key', path.join(dir, 'key.pem')]);
  assert.ok(tls.port, tls.stderr?.());
  const res = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: tls.port, path: '/api/info', ca: fs.readFileSync(path.join(dir, 'cert.pem')), headers: { authorization: `Bearer ${tls.token}` } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    }).on('error', reject);
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).version, '0.1.0');
  await stop(tls);
});

const provider = (apiKey) => ({ id: 'mock', name: 'Mock', kind: 'openai', baseUrl: mockUrl, apiKey, models: ['mock-large'] });
async function askOnce(r) {
  const b = await (await call(r, 'POST', '/api/bots', { body: { name: `B${Date.now()}`, providerId: 'mock', model: 'mock-large', policy: 'auto', isolation: 'host' } })).json();
  const t = await (await call(r, 'POST', '/api/threads', { body: { members: [b.id] } })).json();
  const before = mock.headers.length;
  await call(r, 'POST', `/api/threads/${t.id}/messages`, { body: { text: 'hi' } });
  for (let i = 0; i < 100 && mock.headers.length === before; i++) await sleep(50);
  return mock.headers.at(-1);
}

test('API keys can be environment references, never written to disk', async () => {
  const r = await start('envkey', [], { CREW_TEST_KEY: 'sk-from-env-123' });
  await call(r, 'PUT', '/api/config', { body: { providers: [provider('env:CREW_TEST_KEY')] } });
  const cfg = await (await call(r, 'GET', '/api/config')).json();
  assert.equal(cfg.providers[0].apiKey, 'env:CREW_TEST_KEY', 'a reference is shown, it is not a secret');
  assert.equal(cfg.providers[0].hasKey, true);
  assert.equal((await askOnce(r)).authorization, 'Bearer sk-from-env-123');
  await sleep(300);
  assert.doesNotMatch(fs.readFileSync(path.join(r.home, 'config.json'), 'utf8'), /sk-from-env-123/);
  await stop(r);
});

test('with a master key, API keys are encrypted in config.json', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const r = await start('enc', [], { CREW_SECRET_KEY: key });
  await call(r, 'PUT', '/api/config', { body: { providers: [provider('sk-plain-secret-456')] } });
  await sleep(300);
  const disk = fs.readFileSync(path.join(r.home, 'config.json'), 'utf8');
  assert.doesNotMatch(disk, /sk-plain-secret-456/);
  assert.match(disk, /"apiKey": "enc:v1:/);
  await stop(r);

  const same = await start('enc', [], { CREW_SECRET_KEY: key });
  assert.equal((await askOnce(same)).authorization, 'Bearer sk-plain-secret-456', 'decrypts with the same key');
  await stop(same);

  const wrong = await start('enc', [], { CREW_SECRET_KEY: crypto.randomBytes(32).toString('base64') });
  const cfg = await (await call(wrong, 'GET', '/api/config')).json();
  assert.equal(cfg.providers[0].hasKey, false, 'a wrong key leaves the provider without a key, not with garbage');
  assert.match(wrong.stderr(), /Could not decrypt the API key for Mock/);
  await stop(wrong);
});

test('existing plain-text keys are encrypted once a master key is available', async () => {
  const r = await start('migrate');
  await call(r, 'PUT', '/api/config', { body: { providers: [provider('sk-old-plain-789')] } });
  await sleep(300);
  await stop(r);
  assert.match(fs.readFileSync(path.join(r.home, 'config.json'), 'utf8'), /sk-old-plain-789/);
  const k = crypto.randomBytes(32).toString('base64');
  const again = await start('migrate', [], { CREW_SECRET_KEY: k });
  assert.doesNotMatch(fs.readFileSync(path.join(again.home, 'config.json'), 'utf8'), /sk-old-plain-789/);
  await stop(again);
});
