import templates from './templates.json';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, Config, Connection, Ledger, Routine, RuntimeInfo, ServerEvent, StatusSnapshot, Thread } from '../../runtime/src/types';

export type Spend = Ledger & { monthlyLimit?: number; unpricedBots: string[] };

export type * from '../../runtime/src/types';
export type Conn = Connection;
export type UiConfig = Omit<Config, 'token'>;

export class Client {
  constructor(public conn: Conn) {}
  private get base() {
    return this.conn.url.replace(/\/+$/, '');
  }
  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${this.conn.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Cannot reach ${this.conn.url}`);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
    return j;
  }
  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b: unknown = {}) => this.req<T>('POST', p, b);
  put = <T = any>(p: string, b: unknown) => this.req<T>('PUT', p, b);
  del = <T = any>(p: string) => this.req<T>('DELETE', p);
  events(cb: (e: ServerEvent) => void) {
    const es = new EventSource(`${this.base}/api/events?token=${encodeURIComponent(this.conn.token)}`);
    es.onmessage = (e) => cb(JSON.parse(e.data));
    return es;
  }
  fileUrl(botId: string, path: string) {
    return `${this.base}/api/bots/${botId}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(this.conn.token)}`;
  }
}

export interface Runtime {
  conn: Conn;
  client: Client;
  loading: boolean;
  online: boolean;
  error: string;
  info: RuntimeInfo | null;
  config: UiConfig | null;
  bots: Bot[];
  threads: Thread[];
  routines: Routine[];
  spend: Spend | null;
  status: StatusSnapshot;
  reload: () => Promise<void>;
  subscribe: (fn: (e: ServerEvent) => void) => () => void;
}

const empty = {
  loading: true,
  online: false,
  error: '',
  info: null as RuntimeInfo | null,
  config: null as UiConfig | null,
  bots: [] as Bot[],
  threads: [] as Thread[],
  routines: [] as Routine[],
  spend: null as Spend | null,
  status: { bots: {}, threads: [] } as StatusSnapshot,
};

/** Live view of one runtime (local or remote): data + a server-sent event stream. */
export function useRuntime(conn: Conn): Runtime {
  const client = useMemo(() => new Client(conn), [conn.url, conn.token]);
  const [state, setState] = useState(empty);
  const subs = useRef(new Set<(e: ServerEvent) => void>());
  const alive = useRef(client);
  alive.current = client;

  const reload = useCallback(async () => {
    try {
      const [info, config, bots, threads, routines, spend] = await Promise.all([
        client.get<RuntimeInfo>('/api/info'),
        client.get<UiConfig>('/api/config'),
        client.get<Bot[]>('/api/bots'),
        client.get<Thread[]>('/api/threads'),
        client.get<Routine[]>('/api/routines'),
        client.get<Spend>('/api/spend'),
      ]);
      if (alive.current === client) setState((s) => ({ ...s, loading: false, online: true, error: '', info, config, bots, threads, routines, spend }));
    } catch (e: any) {
      if (alive.current === client) setState((s) => ({ ...s, loading: false, online: false, error: e.message }));
    }
  }, [client]);

  useEffect(() => {
    setState(empty);
    void reload();
    const es = client.events((e) => {
      if (e.type === 'status') {
        setState((s) => ({ ...s, status: e.status }));
        // Runs starting and finishing are when spending changes; cheap enough to refetch then.
        client.get<Spend>('/api/spend').then((spend) => alive.current === client && setState((s) => ({ ...s, spend })), () => {});
      }
      else if (e.type === 'changed') void reload();
      subs.current.forEach((f) => f(e));
    });
    let wasDown = false;
    es.onerror = () => {
      wasDown = true;
      setState((s) => ({ ...s, online: false, error: s.error || `Lost connection to ${client.conn.url}` }));
    };
    es.onopen = () => {
      if (wasDown) void reload();
      wasDown = false;
    };
    return () => es.close();
  }, [client, reload]);

  const subscribe = useCallback((fn: (e: ServerEvent) => void) => {
    subs.current.add(fn);
    return () => void subs.current.delete(fn);
  }, []);

  return { conn, client, ...state, reload, subscribe };
}

export const PRESETS: { label: string; kind: 'openai' | 'anthropic'; baseUrl: string; models: string[]; keyHint: string }[] = [
  { label: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', models: [], keyHint: 'xai-…' },
  { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], keyHint: 'sk-…' },
  { label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], keyHint: 'sk-ant-…' },
  { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: [], keyHint: 'sk-or-…' },
  { label: 'Ollama (local models)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', models: [], keyHint: 'not needed' },
  { label: 'LM Studio (local models)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: [], keyHint: 'not needed' },
  { label: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', models: [], keyHint: 'if required' },
  { label: 'Custom Anthropic-compatible', kind: 'anthropic', baseUrl: '', models: [], keyHint: 'if required' },
];

// Shared with the eval suite (eval/solo), so evaluated teammates match what users get.
export const TEMPLATES: { name: string; role: string; instructions: string; tools?: Partial<Bot['tools']> }[] = templates;

export const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);
