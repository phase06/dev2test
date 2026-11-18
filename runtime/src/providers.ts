import type { Provider } from './types';

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}
interface Opts {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
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
    throw new Error(`Model provider returned ${r.status}: ${text.slice(0, 500)}`);
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

async function openaiChat(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts): Promise<ChatResult> {
  const stream = p.stream !== false;
  const body: any = {
    model,
    stream,
    messages: msgs.map((m) =>
      m.role === 'assistant'
        ? {
            role: 'assistant',
            content: m.content || null,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((t) => ({
                    id: t.id,
                    type: 'function',
                    function: { name: t.name, arguments: t.args || '{}' },
                  })),
                }
              : {}),
          }
        : m.role === 'tool'
          ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
          : { role: m.role, content: m.content },
    ),
  };
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  const r = await post(`${base(p)}/chat/completions`, authHeaders(p), body, o.signal);

  if (!stream) {
    const j: any = await r.json();
    const m = j.choices?.[0]?.message || {};
    const content = typeof m.content === 'string' ? m.content : '';
    if (content) o.onDelta?.(content);
    return {
      content,
      toolCalls: (m.tool_calls || []).map((t: any) => ({
        id: t.id || tcId(),
        name: t.function?.name,
        args: t.function?.arguments || '{}',
      })),
    };
  }

  let content = '';
  const calls: ToolCall[] = [];
  for await (const ev of sse(r)) {
    if (ev.error) throw new Error(`Model provider error: ${ev.error.message || JSON.stringify(ev.error)}`);
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
  return { content, toolCalls: calls.filter(Boolean).map((c) => ({ ...c, id: c.id || tcId(), args: c.args || '{}' })) };
}

const parse = (s: string) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

async function anthropicChat(p: Provider, model: string, msgs: ChatMsg[], tools: ToolDef[], o: Opts): Promise<ChatResult> {
  const stream = p.stream !== false;
  const system = msgs
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', block: any) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of msgs) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content });
    else if (m.role === 'tool')
      push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(empty)' });
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const t of m.toolCalls || []) push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: parse(t.args) });
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });

  const body: any = { model, max_tokens: p.maxTokens || 8192, messages: out, stream };
  if (system) body.system = system;
  if (tools.length)
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
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
    return { content, toolCalls };
  }

  let content = '';
  const blocks: Record<number, ToolCall> = {};
  for await (const ev of sse(r)) {
    if (ev.type === 'error') throw new Error(`Model provider error: ${ev.error?.message || JSON.stringify(ev.error)}`);
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use')
      blocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, args: '' };
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        content += ev.delta.text;
        o.onDelta?.(ev.delta.text);
      } else if (ev.delta?.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].args += ev.delta.partial_json;
    }
  }
  return { content, toolCalls: Object.values(blocks).map((b) => ({ ...b, args: b.args || '{}' })) };
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
