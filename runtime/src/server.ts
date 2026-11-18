import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Bot, Provider, Routine, RuntimeInfo, Thread } from './types';
import { HOME, db, dropMessages, emit, messages, newId, safePath, save, setTeamMemory, subscribe, teamMemory, wsDir } from './store';
import { detectEngine, removeContainer, sandboxInfo } from './sandbox';
import { postMessage, resolveApproval, runRoutine, snapshot, stopThread } from './agent';
import { chat, listModels } from './providers';
import { mcpClients, syncMcp } from './mcp';

export const VERSION = '0.1.0';
const UI_DIR = process.env.CREW_UI || path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.json': 'application/json', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}
const need = <T>(v: T | undefined | null, what: string): T => {
  if (v == null) throw new HttpError(404, `${what} not found`);
  return v;
};

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: string[];
  body: any;
}
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), h]);

/** Merge a provider coming from the UI with the stored key (the UI never receives keys back). */
function withKey(p: Provider): Provider {
  const old = db.config.providers.find((x) => x.id === p.id);
  const { hasKey, ...rest } = p;
  return { ...rest, apiKey: p.apiKey || old?.apiKey || '' };
}

function botFrom(body: any, old?: Bot): Bot {
  const name = String(body.name ?? old?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'A bot needs a name.');
  if (db.bots.some((b) => b.id !== old?.id && b.name.toLowerCase() === name.toLowerCase()))
    throw new HttpError(400, `There is already a teammate named ${name}.`);
  return {
    id: old?.id || newId('bot'),
    name,
    color: body.color || old?.color || COLORS[db.bots.length % COLORS.length],
    role: String(body.role ?? old?.role ?? ''),
    instructions: String(body.instructions ?? old?.instructions ?? ''),
    providerId: String(body.providerId ?? old?.providerId ?? db.config.providers[0]?.id ?? ''),
    model: String(body.model ?? old?.model ?? ''),
    policy: ['auto', 'ask', 'readonly'].includes(body.policy) ? body.policy : old?.policy || 'ask',
    isolation: ['host', 'container'].includes(body.isolation) ? body.isolation : old?.isolation || (sandboxInfo().available ? 'container' : 'host'),
    tools: { shell: true, files: true, web: true, browser: false, mcp: true, team: true, teamMemory: false, ...(old?.tools || {}), ...(body.tools || {}) },
    createdAt: old?.createdAt || Date.now(),
  };
}

const changed = (what: 'bots' | 'threads' | 'routines' | 'config') => emit({ type: 'changed', what });

// ---- Runtime ----
on('GET', '/api/info', async (): Promise<RuntimeInfo> => (await detectEngine(), {
  name: db.config.name,
  version: VERSION,
  platform: `${os.platform()} ${os.arch()}`,
  hostname: os.hostname(),
  home: HOME,
  mcp: mcpClients().map((c) => ({ name: c.cfg.name, status: c.status, tools: c.tools.length, error: c.error })),
  sandbox: sandboxInfo(),
}));
on('GET', '/api/status', () => snapshot());

on('GET', '/api/config', () => ({
  name: db.config.name,
  providers: db.config.providers.map(({ apiKey, ...p }) => ({ ...p, apiKey: '', hasKey: !!apiKey })),
  mcpServers: db.config.mcpServers,
  connections: db.config.connections,
  sandbox: db.config.sandbox,
  compactChars: db.config.compactChars,
}));
on('GET', '/api/team-memory', () => ({ text: teamMemory() }));
on('PUT', '/api/team-memory', ({ body }) => (setTeamMemory(String(body.text ?? '')), { ok: true }));
on('PUT', '/api/config', async ({ body }) => {
  if (typeof body.name === 'string' && body.name.trim()) db.config.name = body.name.trim();
  if (Array.isArray(body.providers))
    db.config.providers = body.providers.map((p: Provider) => ({ ...withKey(p), id: p.id || newId('prov') }));
  if (Array.isArray(body.connections)) db.config.connections = body.connections;
  if (Number(body.compactChars) >= 200) db.config.compactChars = Number(body.compactChars);
  if (body.sandbox && typeof body.sandbox === 'object')
    db.config.sandbox = {
      image: String(body.sandbox.image || '').trim() || db.config.sandbox.image,
      network: body.sandbox.network !== false,
      asRoot: !!body.sandbox.asRoot,
    };
  if (Array.isArray(body.mcpServers)) {
    db.config.mcpServers = body.mcpServers;
    await syncMcp(db.config.mcpServers);
  }
  save('config');
  changed('config');
  return { ok: true };
});
on('POST', '/api/providers/models', async ({ body }) => ({ models: await listModels(withKey(body.provider)) }));
on('POST', '/api/providers/test', async ({ body }) => {
  const r = await chat(withKey(body.provider), body.model, [{ role: 'user', content: 'Reply with the single word: ok' }], [], {
    signal: AbortSignal.timeout(45000),
  });
  return { reply: r.content.slice(0, 200) };
});

// ---- Bots ----
on('GET', '/api/bots', () => db.bots);
on('POST', '/api/bots', ({ body }) => {
  const bot = botFrom(body);
  db.bots.push(bot);
  wsDir(bot.id);
  save('bots');
  changed('bots');
  return bot;
});
on('PUT', '/api/bots/:id', ({ params, body }) => {
  const i = db.bots.findIndex((b) => b.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Bot not found');
  db.bots[i] = botFrom(body, db.bots[i]);
  if (db.bots[i].isolation !== 'container') void removeContainer(db.bots[i].id);
  save('bots');
  changed('bots');
  return db.bots[i];
});
on('DELETE', '/api/bots/:id', async ({ params }) => {
  const id = params[0];
  await removeContainer(id);
  db.bots = db.bots.filter((b) => b.id !== id);
  for (const t of db.threads.filter((t) => t.members.includes(id))) {
    stopThread(t.id);
    if (t.kind === 'group' && t.members.length > 1) t.members = t.members.filter((m) => m !== id);
    else {
      db.threads = db.threads.filter((x) => x !== t);
      dropMessages(t.id);
    }
  }
  db.routines = db.routines.filter((r) => r.botId !== id);
  save('bots'), save('threads'), save('routines');
  changed('bots'), changed('threads'), changed('routines');
  return { ok: true }; // the workspace directory is kept on disk on purpose
});

function wsPath(botId: string, rel: string) {
  need(db.bots.find((b) => b.id === botId), 'Bot');
  try {
    return safePath(wsDir(botId), rel);
  } catch {
    throw new HttpError(400, 'Path outside workspace');
  }
}
on('GET', '/api/bots/:id/files', ({ params, url }) => {
  const dir = wsPath(params[0], url.searchParams.get('path') || '');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
});
on('GET', '/api/bots/:id/file', ({ params, url, res }) => {
  const f = wsPath(params[0], url.searchParams.get('path') || '');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) throw new HttpError(404, 'File not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
  fs.createReadStream(f).pipe(res);
  return undefined;
});
on('PUT', '/api/bots/:id/memory', ({ params, body }) => {
  fs.writeFileSync(wsPath(params[0], 'MEMORY.md'), String(body.text ?? ''));
  return { ok: true };
});

// ---- Threads ----
on('GET', '/api/threads', () => db.threads);
on('POST', '/api/threads', ({ body }) => {
  const members: string[] = (body.members || []).filter((id: string) => db.bots.some((b) => b.id === id));
  if (!members.length) throw new HttpError(400, 'Pick at least one teammate.');
  const kind = members.length > 1 ? 'group' : 'dm';
  const t: Thread = {
    id: newId('t'),
    title: String(body.title || '').trim() || (kind === 'dm' ? db.bots.find((b) => b.id === members[0])!.name : 'Group chat'),
    kind, members, createdAt: Date.now(), updatedAt: Date.now(), hops: 0,
  };
  db.threads.push(t);
  save('threads');
  changed('threads');
  return t;
});
on('DELETE', '/api/threads/:id', ({ params }) => {
  stopThread(params[0]);
  db.threads = db.threads.filter((t) => t.id !== params[0]);
  dropMessages(params[0]);
  save('threads');
  changed('threads');
  return { ok: true };
});
const thread = (id: string) => need(db.threads.find((t) => t.id === id), 'Thread');
on('GET', '/api/threads/:id/messages', ({ params }) => messages(thread(params[0]).id));
on('POST', '/api/threads/:id/messages', ({ params, body }) => {
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Empty message');
  return postMessage(thread(params[0]), { type: 'user', name: 'You' }, text);
});
on('POST', '/api/threads/:id/stop', ({ params }) => (stopThread(params[0]), { ok: true }));
on('POST', '/api/approvals/:id', ({ params, body }) => ({ ok: resolveApproval(params[0], body.decision) }));

// ---- Routines ----
on('GET', '/api/routines', () => db.routines);
const routineFrom = (body: any, old?: Routine): Routine => ({
  id: old?.id || newId('rt'),
  name: String(body.name ?? old?.name ?? 'Routine').trim() || 'Routine',
  botId: need(db.bots.find((b) => b.id === (body.botId ?? old?.botId)), 'Bot').id,
  prompt: String(body.prompt ?? old?.prompt ?? ''),
  cron: String(body.cron ?? old?.cron ?? '').trim(),
  enabled: body.enabled ?? old?.enabled ?? true,
  threadId: old?.botId === (body.botId ?? old?.botId) ? old?.threadId : undefined,
  lastRun: old?.lastRun,
});
on('POST', '/api/routines', ({ body }) => {
  const r = routineFrom(body);
  db.routines.push(r);
  save('routines');
  changed('routines');
  return r;
});
on('PUT', '/api/routines/:id', ({ params, body }) => {
  const i = db.routines.findIndex((r) => r.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Routine not found');
  db.routines[i] = routineFrom(body, db.routines[i]);
  save('routines');
  changed('routines');
  return db.routines[i];
});
on('DELETE', '/api/routines/:id', ({ params }) => {
  db.routines = db.routines.filter((r) => r.id !== params[0]);
  save('routines');
  changed('routines');
  return { ok: true };
});
on('POST', '/api/routines/:id/run', ({ params }) => ({
  threadId: runRoutine(need(db.routines.find((r) => r.id === params[0]), 'Routine')),
}));

// ---- HTTP plumbing ----
function authed(req: http.IncomingMessage, url: URL) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(db.config.token).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 8e6) reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(url: URL, res: http.ServerResponse) {
  let f = path.join(UI_DIR, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, ''));
  if (!f.startsWith(UI_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(UI_DIR, 'index.html');
  if (!fs.existsSync(f)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Crew runtime is running, but the UI bundle was not found. Run `npm run build`.');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    // Auth is a bearer token (never cookies), so any origin may call the API: this is what lets a
    // desktop app served from the local runtime talk to runtimes on other machines.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (!authed(req, url)) return json(401, { error: 'Invalid or missing token' });

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ type: 'status', status: snapshot() });
      const off = subscribe(send);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => (off(), clearInterval(ping)));
      return;
    }

    try {
      for (const [method, re, handler] of routes) {
        const m = req.method === method && re.exec(url.pathname);
        if (!m) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
        const out = await handler({ req, res, url, params: m.slice(1).map(decodeURIComponent), body });
        if (out !== undefined) json(200, out);
        return;
      }
      json(404, { error: 'Not found' });
    } catch (e: any) {
      if (!res.headersSent) json(e instanceof HttpError ? e.status : 500, { error: e?.message || String(e) });
    }
  });
}
