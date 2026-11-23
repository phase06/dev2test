import type { Effort, Provider, Usage } from './types';
import { resolveKey } from './secrets';

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
  /**
   * Anthropic only: the assistant turn's original content blocks (thinking, text, tool_use, ...),
   * replayed verbatim instead of being rebuilt from content/toolCalls.
   */
  raw?: unknown[];
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
  /** Model id reported by the provider, when it reports one. */
  model?: string;
  /** Why generation stopped, normalised: 'end', 'tool_use', 'max_tokens', 'refusal' or the raw value. */
  stopReason?: string;
  /** Set when stopReason is 'refusal'. */
  refusal?: { category?: string | null; explanation?: string };
  /** Anthropic only: the content blocks to replay for this turn (see ChatMsg.raw). */
  raw?: unknown[];
}

const normStop = (s?: string | null) =>
  !s
    ? undefined
    : s === 'end_turn' || s === 'stop' || s === 'stop_sequence'
      ? 'end'
      : s === 'tool_calls'
        ? 'tool_use'
        : s === 'length'
          ? 'max_tokens'
          : s === 'content_filter'
            ? 'refusal'
            : s;
interface Opts {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** "none" offers the tools (so the cached prefix matches) but forbids calling them. */
  toolChoice?: 'auto' | 'none';
  /** How hard the model should think. Unset: the model's default. */
  effort?: Effort;
  /** Short progress notes the model writes between tool calls (Anthropic thinking "updates"). */
  onNote?: (text: string) => void;
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
  const key = resolveKey(p.apiKey);
  const h: Record<string, string> =
    p.kind === 'anthropic'
      ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
      : key
        ? { authorization: `Bearer ${key}` }
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
  // OpenAI-style reasoning models take low/medium/high; the higher Claude levels map to high.
  if (o.effort) body.reasoning_effort = o.effort === 'low' || o.effort === 'medium' ? o.effort : 'high';
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
      model: j.model,
      stopReason: m.refusal ? 'refusal' : normStop(j.choices?.[0]?.finish_reason),
      ...(m.refusal || j.choices?.[0]?.finish_reason === 'content_filter' ? { refusal: { explanation: m.refusal || undefined } } : {}),
    };
  }

  let content = '';
  let usage: ChatResult['usage'];
  let served: string | undefined;
  let stop: string | undefined;
  let refusalText = '';
  const calls: ToolCall[] = [];
  for await (const ev of sse(r)) {
    if (ev.error) throw new Error(`Model provider error: ${ev.error.message || JSON.stringify(ev.error)}`);
    if (ev.usage) usage = openaiUsage(ev.usage);
    if (ev.model) served = ev.model;
    if (ev.choices?.[0]?.finish_reason) stop = ev.choices[0].finish_reason;
    const d = ev.choices?.[0]?.delta;
    if (!d) continue;
    if (typeof d.refusal === 'string') refusalText += d.refusal;
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
  const refused = !!refusalText || stop === 'content_filter';
  return {
    content,
    usage,
    model: served,
    stopReason: refused ? 'refusal' : normStop(stop),
    ...(refused ? { refusal: { explanation: refusalText || undefined } } : {}),
    toolCalls: calls.filter(Boolean).map((c) => ({ ...c, id: c.id || tcId(), args: c.args || '{}' })),
  };
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
  // With server-side fallbacks, top-level usage covers only the attempt that produced the reply;
  // usage.iterations has every attempt, so sum those when present.
  const parts: any[] = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  const sum = (k: string) => parts.reduce((t, x) => t + n(x?.[k]), 0);
  return { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens') };
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Optional request features, each behind a beta header that a model or gateway may reject.
 * A feature is switched off for that provider + model when a 400 names it, instead of failing runs.
 *   binding:   replay thinking blocks with prefix_mismatch_behavior "drop_block", so a block whose
 *              earlier context Crew has since edited (memory, clipped outputs, compaction) is dropped
 *              by the API instead of failing the request (enforced on accounts from 2026-08-31).
 *   updates:   thinking display "updates": the short notes Claude writes between tool calls.
 *   fallbacks: server-side fallback to another model when Claude declines a request.
 */
type Feature = 'binding' | 'updates' | 'fallbacks';
const FEATURE_ERRORS: Record<Feature, RegExp> = {
  binding: /block_binding|prefix_mismatch|thinking-binding|thinking\.type|adaptive/i,
  updates: /display|thinking-display/i,
  fallbacks: /fallback/i,
};
const BETAS: Record<Feature, string> = {
  binding: 'thinking-binding-controls-2026-08-01',
  updates: 'thinking-display-updates-2026-08-18',
  fallbacks: 'server-side-fallback-2026-07-01',
};
const switchedOff = new Map<string, Set<Feature>>();

/** Models that think by default, so sending adaptive thinking changes nothing but lets us set its options. */
const thinksByDefault = (model: string) => /claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model);
/** Models with server-side fallback targets. */
const hasFallbacks = (model: string) => /claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(model);
const officialHost = (p: Provider) => {
  try {
    return new URL(p.baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
};

function anthropicFeatures(p: Provider, model: string): Feature[] {
  const f: Feature[] = [];
  if (thinksByDefault(model)) f.push('binding', 'updates');
  if ((p.fallbacks ?? officialHost(p)) && hasFallbacks(model)) f.push('fallbacks');
  return f;
}

export function anthropicRequest(model: string, maxTokens: number, msgs: ChatMsg[], tools: ToolDef[], o: Opts, stream: boolean, feats: Feature[] = []) {
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
      if (m.raw?.length) {
        // Thinking blocks must go back exactly as received, in their original order.
        for (const b of m.raw) push('assistant', b);
        continue;
      }
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
  if (feats.includes('binding') || feats.includes('updates'))
    body.thinking = {
      type: 'adaptive',
      ...(feats.includes('updates') ? { display: 'updates' } : {}),
      ...(feats.includes('binding') ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } } : {}),
    };
  if (o.effort) body.output_config = { effort: o.effort };
  if (feats.includes('fallbacks')) body.fallbacks = 'default';
  return { body, betas: feats.map((f) => BETAS[f]) };
}

/**
 * After a fallback mid-reply, the blocks before the last `fallback` block came from the model that
 * declined: they are not replayed (except text) and their tool calls are not run.
 */
function splitAtFallback(blocks: any[]) {
  const cut = blocks.findLastIndex((b) => b?.type === 'fallback');
  // Empty text blocks are rejected by the API on replay, so they are the one thing left out.
  const raw = blocks.filter((b, i) => b && (i >= cut || b.type === 'text') && !(b.type === 'text' && !b.text));
  const live = cut >= 0 ? blocks.slice(cut + 1) : blocks;
  const toolCalls: ToolCall[] = live.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) }));
  return { raw, toolCalls, fallbackTo: cut >= 0 ? (blocks[cut].to?.model as string | undefined) : undefined };
}

async function anthropicOnce(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts, feats: Feature[]): Promise<ChatResult> {
  const stream = p.stream !== false;
  // Thinking counts toward max_tokens, so leave room for it when streaming (no HTTP timeout risk).
  const { body, betas } = anthropicRequest(model, p.maxTokens || (stream ? 64000 : 16000), msgs, tools, o, stream, feats);
  const headers = authHeaders(p);
  const allBetas = [headers['anthropic-beta'], ...betas].filter(Boolean).join(',');
  if (allBetas) headers['anthropic-beta'] = allBetas;
  const r = await post(`${anthropicBase(p)}/v1/messages`, headers, body, o.signal);

  if (!stream) {
    const j: any = await r.json();
    const blocks: any[] = j.content || [];
    const { raw, toolCalls } = splitAtFallback(blocks);
    const content = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (content) o.onDelta?.(content);
    for (const b of blocks) if (b.type === 'thinking' && b.thinking?.trim()) o.onNote?.(b.thinking.trim());
    return {
      content,
      toolCalls,
      raw,
      usage: anthropicUsage(j.usage),
      model: j.model,
      stopReason: normStop(j.stop_reason),
      ...(j.stop_reason === 'refusal' ? { refusal: { category: j.stop_details?.category, explanation: j.stop_details?.explanation } } : {}),
    };
  }

  let content = '';
  let usage: ChatResult['usage'];
  let served: string | undefined;
  let stop: string | undefined;
  let stopDetails: any;
  const blocks: any[] = [];
  const json: Record<number, string> = {};
  for await (const ev of sse(r)) {
    if (ev.type === 'error') throw new Error(`Model provider error: ${ev.error?.message || JSON.stringify(ev.error)}`);
    if (ev.type === 'message_start') {
      usage = anthropicUsage(ev.message?.usage);
      served = ev.message?.model;
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      stopDetails = ev.delta?.stop_details ?? ev.stop_details ?? stopDetails;
      if (ev.usage) {
        // message_delta carries cumulative counts; some fields may be absent.
        const d = anthropicUsage(ev.usage)!;
        usage = Array.isArray(ev.usage.iterations)
          ? d
          : { input: usage?.input || d.input, output: d.output, cacheRead: usage?.cacheRead || d.cacheRead, cacheWrite: usage?.cacheWrite || d.cacheWrite };
      }
    } else if (ev.type === 'content_block_start' && ev.content_block) {
      const b = { ...ev.content_block };
      blocks[ev.index] = b;
      if (b.type === 'tool_use') json[ev.index] = '';
      if (b.type === 'text' && b.text) {
        content += b.text;
        o.onDelta?.(b.text);
      }
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index];
      const d = ev.delta;
      if (!b || !d) continue;
      if (d.type === 'text_delta') {
        b.text = (b.text ?? '') + d.text;
        content += d.text;
        o.onDelta?.(d.text);
      } else if (d.type === 'input_json_delta') json[ev.index] = (json[ev.index] ?? '') + d.partial_json;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
    } else if (ev.type === 'content_block_stop') {
      const b = blocks[ev.index];
      if (b?.type === 'tool_use') b.input = parse(json[ev.index] ?? '');
      if (b?.type === 'thinking' && b.thinking?.trim()) o.onNote?.(b.thinking.trim());
    }
  }
  // Normally done at content_block_stop; repeated here in case a stream ended without one.
  for (const [i, j] of Object.entries(json)) if (blocks[+i]) blocks[+i].input = parse(j);
  const { raw, toolCalls, fallbackTo } = splitAtFallback(blocks);
  return {
    content,
    usage,
    raw,
    toolCalls,
    model: fallbackTo ?? served,
    stopReason: normStop(stop),
    ...(stop === 'refusal' ? { refusal: { category: stopDetails?.category, explanation: stopDetails?.explanation } } : {}),
  };
}

async function anthropicChat(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts): Promise<ChatResult> {
  const key = `${base(p)}\u0000${model}`;
  const off = switchedOff.get(key) ?? new Set<Feature>();
  switchedOff.set(key, off);
  for (let attempt = 0; ; attempt++) {
    const feats = anthropicFeatures(p, model).filter((f) => !off.has(f));
    try {
      return await anthropicOnce(p, model, msgs, tools, o, feats);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 400 || !feats.length || attempt >= 3) throw e;
      const named = feats.filter((f) => FEATURE_ERRORS[f].test(e.body));
      if (named.length) {
        named.forEach((f) => off.add(f));
        console.warn(`${model}: turning off ${named.join(', ')} after: ${e.body.slice(0, 200)}`);
        continue;
      }
      // A 400 that names none of them: try once without any, and keep them off only if that works.
      const res = await anthropicOnce(p, model, msgs, tools, o, []).catch(() => null);
      if (!res) throw e;
      feats.forEach((f) => off.add(f));
      console.warn(`${model}: turning off ${feats.join(', ')} after: ${e.body.slice(0, 200)}`);
      return res;
    }
  }
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
