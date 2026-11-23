import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Bot, Config, Ledger, Message, Routine, ServerEvent, Thread } from './types';

export const HOME = path.resolve(process.env.CREW_HOME || path.join(os.homedir(), '.crew'));
fs.mkdirSync(path.join(HOME, 'messages'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'workspaces'), { recursive: true });

const file = (n: string) => path.join(HOME, n);

function load<T>(n: string, def: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(n), 'utf8'));
  } catch {
    return def;
  }
}

function write(n: string, data: unknown) {
  const f = file(n);
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(t, f);
}

export const newId = (prefix: string) => prefix + '_' + crypto.randomBytes(6).toString('hex');

export const db = {
  config: load<Config | null>('config.json', null) as Config,
  bots: load<Bot[]>('bots.json', []),
  threads: load<Thread[]>('threads.json', []),
  routines: load<Routine[]>('routines.json', []),
  spend: load<Ledger | null>('spend.json', null) as Ledger,
};

if (!db.config) {
  db.config = {
    token: crypto.randomBytes(24).toString('base64url'),
    name: os.hostname(),
    providers: [],
    mcpServers: [],
    connections: [],
  } as unknown as Config;
  write('config.json', db.config);
}
db.config.connections ??= [];
db.config.mcpServers ??= [];
db.config.sandbox ??= { image: 'node:22-bookworm', network: true, asRoot: process.platform !== 'linux' };
{
  const c = db.config as Config & { compactChars?: number };
  c.contextTokens ??= c.compactChars ? Math.round(c.compactChars / 4) : 32000;
  delete c.compactChars;
}

const msgCache = new Map<string, Message[]>();

export function messages(threadId: string): Message[] {
  let m = msgCache.get(threadId);
  if (!m) {
    m = load<Message[]>(`messages/${threadId}.json`, []);
    // Anything still "streaming" on disk was cut off by a restart.
    for (const x of m) if (x.status === 'streaming') x.status = 'stopped';
    msgCache.set(threadId, m);
  }
  return m;
}

export function dropMessages(threadId: string) {
  msgCache.delete(threadId);
  fs.rmSync(file(`messages/${threadId}.json`), { force: true });
}

type Saveable = 'config' | 'bots' | 'threads' | 'routines' | 'spend' | `messages/${string}`;
const dirty = new Set<Saveable>();
let timer: NodeJS.Timeout | undefined;

export function save(what: Saveable) {
  dirty.add(what);
  timer ??= setTimeout(flush, 150);
}

export function flush() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  for (const w of dirty) {
    if (w.startsWith('messages/')) {
      const m = msgCache.get(w.slice(9));
      if (m) write(w + '.json', m);
    } else write(w + '.json', (db as any)[w]);
  }
  dirty.clear();
}

export function wsDir(botId: string) {
  const d = path.join(HOME, 'workspaces', botId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Resolve `p` inside `root`, following symlinks, and refuse anything that lands outside. Symlinks
 * matter because an isolated bot can create one in its workspace that points at a host path.
 */
export function safePath(root: string, p: string): string {
  const base = fs.realpathSync(root);
  let probe = path.resolve(base, p || '.');
  const tail: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      tail.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
  let real: string;
  try {
    real = path.join(fs.realpathSync(probe), ...tail);
  } catch {
    throw new Error('Path is outside the workspace.'); // dangling symlink
  }
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error('Path is outside the workspace.');
  return real;
}

const TEAM_FILE = file('TEAM.md');
export const teamMemory = () => {
  try {
    return fs.readFileSync(TEAM_FILE, 'utf8');
  } catch {
    return '';
  }
};
export const setTeamMemory = (text: string) => fs.writeFileSync(TEAM_FILE, text, { mode: 0o600 });

const listeners = new Set<(e: ServerEvent) => void>();
export const emit = (e: ServerEvent) => listeners.forEach((l) => l(e));
export const subscribe = (l: (e: ServerEvent) => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
