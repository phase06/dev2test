import type { Provider, Usage } from './types';

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}
export interface ImageInput {
  mediaType: string;
  /** base64, no data: prefix */
  data: string;
}
export interface ChatMsg {
  /**
   * System messages are sent first, in order. Keep stable text in the first one and anything that
   * changes between runs in later ones: the first block's end is a cache breakpoint.
   */
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Images returned by a tool (role "tool" only). */
  images?: ImageInput[];
}
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: Omit<Usage, 'calls'>;
}
interface Opts {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** "none" offers the tools (so the cached prefix matches) but forbids calling them. */
  toolChoice?: 'auto' | 'none';
}

export class ProviderError extends Error {
  constructor(public status: number, public body: string) {
    super(`Model provider returned ${status}: ${body.slice(0, 500)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = (p: Provider) => p.baseUrl.trim().replace(/\/+$/, '');
const anthropicBase = (p: Provider) => base(p).replace(/\/v1$/, '');

function authHeaders(p: Provider): Record<string, string> {
  const h: Record<string, string> =
    p.kind === 'anthropic'
      ? { 'anthropic-version': '2023-06-01', ...(p.apiKey ? { 'x-api-key': p.apiKey } : {}) }
      : p.apiKey
        ? { authorization: `Bearer ${p.apiKey}` }
        : {};
  return { ...h, ...(p.headers || {}) };
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (r.ok) return r;
    const text = await r.text().catch(() => '');
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new ProviderError(r.status, text);
  }
}

async function* sse(r: Response): AsyncGenerator<any> {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        yield JSON.parse(d);
      } catch {
        /* ignore keepalives / partial junk */
      }
    }
  }
}

const tcId = () => 'call_' + Math.random().toString(36).slice(2, 12);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------- OpenAI-compatible ----------

/** Providers (by base URL) that rejected `stream_options`, so we stop sending it. */
const noStreamOptions = new Set<string>();

function openaiUsage(u: any): ChatResult['usage'] {
  if (!u) return undefined;
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens);
  return { input: Math.max(0, n(u.prompt_tokens) - cached), output: n(u.completion_tokens), cacheRead: cached, cacheWrite: 0 };
}

function openaiMessages(msgs: ChatMsg[]) {
  // One system message: some local chat templates only honour the first. Stable text stays first,
  // which is what automatic prefix caching (OpenAI, xAI, DeepSeek, …) keys on.
  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: any[] = system ? [{ role: 'system', content: system }] : [];
  let pendingImages: { id: string; images: ImageInput[] }[] = [];
  const flushImages = () => {
    // Tool messages can only carry text, so images follow the tool results as one user message.
    if (!pendingImages.length) return;
    const content: any[] = [];
    for (const p of pendingImages) {
      content.push({ type: 'text', text: `Image output of tool call ${p.id}:` });
      for (const img of p.images) content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
    }
    out.push({ role: 'user', content });
    pendingImages = [];
  };
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role !== 'tool') flushImages();
    if (m.role === 'assistant')
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })) }
          : {}),
      });
    else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      if (m.images?.length) pendingImages.push({ id: m.toolCallId!, images: m.images });
    } else out.push({ role: m.role, content: m.content });
  }
  flushImages();
  return out;
}

async function openaiChat(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts): Promise<ChatResult> {
  const stream = p.stream !== false;
  const body: any = { model, stream, messages: openaiMessages(msgs) };
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: t }));
    if (o.toolChoice === 'none') body.tool_choice = 'none';
  }
  const url = `${base(p)}/chat/completions`;
  if (stream && !noStreamOptions.has(url)) body.stream_options = { include_usage: true };
  let r: Response;
  try {
    r = await post(url, authHeaders(p), body, o.signal);
  } catch (e) {
    if (!(e instanceof ProviderError && e.status >= 400 && e.status < 500 && body.stream_options && /stream_options|include_usage/i.test(e.body))) throw e;
    noStreamOptions.add(url); // an older or stricter server: retry without usage reporting
    delete body.stream_options;
    r = await post(url, authHeaders(p), body, o.signal);
  }

  if (!stream) {
    const j: any = await r.json();
    const m = j.choices?.[0]?.message || {};
    const content = typeof m.content === 'string' ? m.content : '';
    if (content) o.onDelta?.(content);
    return {
      content,
      toolCalls: (m.tool_calls || []).map((t: any) => ({ id: t.id || tcId(), name: t.function?.name, args: t.function?.arguments || '{}' })),
      usage: openaiUsage(j.usage),
    };
  }

  let content = '';
  let usage: ChatResult['usage'];
  const calls: ToolCall[] = [];
  for await (const ev of sse(r)) {
    if (ev.error) throw new Error(`Model provider error: ${ev.error.message || JSON.stringify(ev.error)}`);
    if (ev.usage) usage = openaiUsage(ev.usage);
    const d = ev.choices?.[0]?.delta;
    if (!d) continue;
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      o.onDelta?.(d.content);
    }
    for (const t of d.tool_calls || []) {
      const i = t.index ?? calls.length - (t.id ? 0 : 1);
      const c = (calls[i] ??= { id: '', name: '', args: '' });
      if (t.id) c.id = t.id;
      if (t.function?.name) c.name += t.function.name;
      if (t.function?.arguments) c.args += t.function.arguments;
    }
  }
  return { content, usage, toolCalls: calls.filter(Boolean).map((c) => ({ ...c, id: c.id || tcId(), args: c.args || '{}' })) };
}

// ---------- Anthropic Messages ----------

const parse = (s: string) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

function anthropicUsage(u: any): ChatResult['usage'] {
  if (!u) return undefined;
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
}

const EPHEMERAL = { type: 'ephemeral' } as const;

export function anthropicRequest(model: string, maxTokens: number, msgs: ChatMsg[], tools: ToolDef[], o: Opts, stream: boolean) {
  // Prompt caching, with explicit breakpoints only (gateways may not support the automatic form):
  //   1. end of the first system block — tools + the stable part of the system prompt
  //   2. end of the last system block — plus memory/summary, which change between runs
  //   3. last block of the conversation — everything so far, read back by the next step
  // Caching is a prefix match, so the harness keeps everything before each breakpoint byte-stable.
  const system = msgs.filter((m) => m.role === 'system' && m.content).map((m) => ({ type: 'text', text: m.content }) as any);
  if (system.length) system[system.length - 1].cache_control = EPHEMERAL;
  if (system.length > 1) system[0].cache_control = EPHEMERAL;

  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', block: any) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of msgs) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content });
    else if (m.role === 'tool') {
      const content: any[] = [{ type: 'text', text: m.content || '(empty)' }];
      for (const img of m.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content });
    } else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const t of m.toolCalls || []) push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: parse(t.args) });
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });
  const lastMsg = out[out.length - 1];
  lastMsg.content[lastMsg.content.length - 1] = { ...lastMsg.content[lastMsg.content.length - 1], cache_control: EPHEMERAL };

  const body: any = { model, max_tokens: maxTokens, messages: out, stream };
  if (system.length) body.system = system;
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (o.toolChoice === 'none') body.tool_choice = { type: 'none' };
  }
  return body;
}

async function anthropicChat(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts): Promise<ChatResult> {
  const stream = p.stream !== false;
  const body = anthropicRequest(model, p.maxTokens || 16000, msgs, tools, o, stream);
  const r = await post(`${anthropicBase(p)}/v1/messages`, authHeaders(p), body, o.signal);

  if (!stream) {
    const j: any = await r.json();
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const b of j.content || []) {
      if (b.type === 'text') content += b.text;
      if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: JSON.stringify(b.input || {}) });
    }
    if (content) o.onDelta?.(content);
    return { content, toolCalls, usage: anthropicUsage(j.usage) };
  }

  let content = '';
  let usage: ChatResult['usage'];
  const blocks: Record<number, ToolCall> = {};
  for await (const ev of sse(r)) {
    if (ev.type === 'error') throw new Error(`Model provider error: ${ev.error?.message || JSON.stringify(ev.error)}`);
    if (ev.type === 'message_start') usage = anthropicUsage(ev.message?.usage);
    if (ev.type === 'message_delta' && ev.usage) {
      // message_delta carries cumulative counts; some fields may be absent.
      const d = anthropicUsage(ev.usage)!;
      usage = { input: usage?.input || d.input, output: d.output, cacheRead: usage?.cacheRead || d.cacheRead, cacheWrite: usage?.cacheWrite || d.cacheWrite };
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use')
      blocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, args: '' };
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        content += ev.delta.text;
        o.onDelta?.(ev.delta.text);
      } else if (ev.delta?.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].args += ev.delta.partial_json;
    }
  }
  return { content, usage, toolCalls: Object.values(blocks).map((b) => ({ ...b, args: b.args || '{}' })) };
}

export function chat(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts = {}): Promise<ChatResult> {
  if (!model) throw new Error('No model selected for this bot.');
  return p.kind === 'anthropic' ? anthropicChat(p, model, msgs, tools, o) : openaiChat(p, model, msgs, tools, o);
}

export async function listModels(p: Provider): Promise<string[]> {
  const url = p.kind === 'anthropic' ? `${anthropicBase(p)}/v1/models?limit=100` : `${base(p)}/models`;
  const r = await fetch(url, { headers: authHeaders(p), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json();
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return list.map((m: any) => m.id || m.name).filter(Boolean);
}
