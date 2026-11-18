import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Bot, BotStatus, Message, Part, Routine, StatusSnapshot, Thread } from './types';
import type { Provider } from './types';
import { chat, type ChatMsg } from './providers';
import { db, emit, messages, newId, safePath, save, teamMemory, wsDir } from './store';
import { toolsFor, type Tool, type ToolCtx } from './tools';

const MAX_STEPS = 50;
const MAX_HOPS = 12; // bot-to-bot handoffs allowed per human message in a group chat
const HISTORY = 200; // hard cap on replayed messages, in case summarisation keeps failing
const KEEP_RECENT = 10; // messages always replayed verbatim
const OLD_RESULT = 3000; // tool results in my earlier turns are clipped to this

type ToolPart = Extract<Part, { type: 'tool' }>;
interface Approval {
  id: string;
  botId: string;
  threadId: string;
  resolve: (d: 'approve' | 'deny' | 'always') => void;
}

const running = new Map<string, { abort: AbortController; botId: string; threadId: string }>();
const approvals = new Map<string, Approval>();
const queues = new Map<string, Promise<unknown>>();

export function snapshot(): StatusSnapshot {
  const bots: Record<string, BotStatus> = {};
  for (const b of db.bots) bots[b.id] = 'idle';
  for (const r of running.values()) bots[r.botId] = 'working';
  for (const a of approvals.values()) bots[a.botId] = 'approval';
  return { bots, threads: [...new Set([...running.values()].map((r) => r.threadId))] };
}
const emitStatus = () => emit({ type: 'status', status: snapshot() });

export function resolveApproval(id: string, decision: 'approve' | 'deny' | 'always') {
  const a = approvals.get(id);
  if (!a) return false;
  a.resolve(decision);
  return true;
}

export function stopThread(threadId: string) {
  for (const r of running.values()) if (r.threadId === threadId) r.abort.abort();
}

const textOf = (m: Message) =>
  m.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();

function systemPrompt(bot: Bot, thread: Thread): string {
  const ws = wsDir(bot.id);
  let memory = '';
  try {
    memory = fs.readFileSync(safePath(ws, 'MEMORY.md'), 'utf8').trim().slice(-6000);
  } catch {
    /* no memory yet */
  }
  const team = teamMemory().trim().slice(-6000);
  const mates = db.bots.filter((b) => b.id !== bot.id);
  const members = thread.members.map((id) => db.bots.find((b) => b.id === id)?.name).filter(Boolean);
  const where =
    thread.kind === 'group'
      ? `This is a group chat "${thread.title}" with the user and these teammates: ${members.join(', ')}. Messages from others are prefixed with [Name]; never prefix your own. To hand work to a teammate here, @mention them by name (e.g. @${mates[0]?.name ?? 'Name'}) with a clear request. Only @mention someone when you need them to act — a mention always triggers them to respond. If the work is finished, don't mention anyone.`
      : thread.kind === 'internal'
        ? 'A teammate is delegating work to you. Their message is prefixed with [Name]. Do the work and reply with a complete, self-contained result — it is returned to them directly.'
        : thread.kind === 'routine'
          ? 'This thread is a scheduled routine. Nobody may be watching: do the work end to end and finish with a short report of the outcome.'
          : 'This is a direct conversation with the user.';
  return [
    `You are ${bot.name}${bot.role ? `, ${bot.role}` : ''} — an AI teammate in Crew. You are a colleague who finishes work, not a chatbot that describes it.`,
    bot.instructions.trim(),
    `## Your computer
${
  bot.isolation === 'container'
    ? `You have your own Linux container (image ${db.config.sandbox.image}${db.config.sandbox.network ? '' : ', no network access'}) on "${db.config.name}". Shell commands run inside it, starting in /workspace, which is your persistent workspace; everything outside /workspace is reset when the container is rebuilt. File tools take paths relative to the workspace.`
    : `You run directly on "${db.config.name}" (${os.platform()} ${os.arch()}). Your workspace directory is ${ws}; file tools are confined to it and shell commands start there.`
} Use your tools to actually do the task, verify the result, then report briefly: what you did, where the output is, and anything the user must decide. If something is ambiguous but low-risk, make a sensible choice and say so.`,
    `## Conversation\n${where}`,
    mates.length ? `## Your team\n${mates.map((b) => `- ${b.name}: ${b.role || 'teammate'}`).join('\n')}` : '',
    team ? `## Team memory\nShared notes every teammate reads (TEAM.md). Treat them as standing context from the user.\n${team}` : '',
    thread.summary ? `## Earlier in this conversation\nOlder messages are no longer shown to you in full. Summary of them:\n${thread.summary.text}` : '',
    `## Memory\nUse the remember tool for durable preferences and facts. When you complete a workflow the user will want repeated, offer to save it with save_routine.\n${memory ? `Your saved memory:\n${memory}` : '(nothing saved yet)'}`,
    `Current time: ${new Date().toString()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildContext(bot: Bot, thread: Thread): ChatMsg[] {
  const out: ChatMsg[] = [{ role: 'system', content: systemPrompt(bot, thread) }];
  const msgs = messages(thread.id).slice(thread.summary?.count ?? 0).slice(-HISTORY);
  for (const m of msgs) {
    const current = m === msgs[msgs.length - 1];
    if (m.author.type === 'bot' && m.author.id === bot.id) {
      // Replay my own turn as assistant messages interleaved with tool results.
      let cur: { content: string; calls: ToolPart[] } | null = null;
      const flush = () => {
        if (cur && (cur.content || cur.calls.length)) {
          out.push({ role: 'assistant', content: cur.content, toolCalls: cur.calls.map((c) => ({ id: c.id, name: c.name, args: c.args })) });
          for (const c of cur.calls) out.push({ role: 'tool', toolCallId: c.id, content: c.result === undefined ? '(interrupted before a result was produced)' : current || c.result.length <= OLD_RESULT ? c.result : c.result.slice(0, OLD_RESULT) + '\n…[clipped]' });
        }
        cur = null;
      };
      for (const p of m.parts) {
        if (p.type === 'text') {
          if (cur?.calls.length) flush();
          cur ??= { content: '', calls: [] };
          cur.content += p.text;
        } else {
          cur ??= { content: '', calls: [] };
          cur.calls.push(p);
        }
      }
      flush();
    } else {
      const text = textOf(m);
      if (!text) continue;
      const plain = thread.kind === 'dm' && m.author.type === 'user';
      out.push({ role: 'user', content: plain ? text : `[${m.author.name}]: ${text}` });
    }
  }
  return out;
}

const SUMMARISER = `You maintain a running summary of a workplace conversation so that AI teammates can continue it without the full transcript. Update the summary with the new messages.
Keep: the user's goals and decisions; constraints and preferences; what each participant did, with the files, commands and results that matter; open tasks and unanswered questions; exact names, paths, ids and numbers later work depends on.
Drop pleasantries and details that were superseded. Plain text, under 500 words. Output only the updated summary.`;

const sizeOf = (m: Message) => m.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : p.args.length + (p.result?.length ?? 0)), 0);

/**
 * Summarise old history once a thread outgrows the budget. The summary is stored on the thread and
 * shared by every bot in it; the messages themselves stay on disk and in the UI.
 */
async function compact(bot: Bot, thread: Thread, provider: Provider, signal: AbortSignal) {
  const start = thread.summary?.count ?? 0;
  const live = messages(thread.id).slice(start, -1); // the last message is the reply being written
  const limit = db.config.compactChars;
  if (live.length <= 2 || live.reduce((n, m) => n + sizeOf(m), 0) <= limit) return;
  // Keep the most recent messages verbatim, but never more than half the budget's worth.
  let keep = 0;
  for (let kept = 0; keep < Math.min(KEEP_RECENT, live.length - 1); keep++) {
    kept += sizeOf(live[live.length - 1 - keep]);
    if (kept > limit / 2 && keep >= 1) break;
  }
  const chunk = live.slice(0, live.length - keep);
  if (!chunk.length) return;
  const transcript = chunk
    .map((m) =>
      m.parts
        .map((p) =>
          p.type === 'text'
            ? `[${m.author.name}]: ${p.text.slice(0, 4000)}`
            : `[${m.author.name} used ${p.name}] ${p.args.slice(0, 400)} -> ${(p.result ?? '').slice(0, 400)}`,
        )
        .join('\n'),
    )
    .join('\n')
    .slice(-200000);
  const res = await chat(
    provider,
    bot.model,
    [
      { role: 'system', content: SUMMARISER },
      { role: 'user', content: `${thread.summary ? `Summary so far:\n${thread.summary.text}\n\n` : ''}New messages:\n${transcript}` },
    ],
    [],
    { signal },
  );
  if (!res.content.trim()) return;
  thread.summary = { text: res.content.trim(), count: start + chunk.length };
  save('threads');
  emit({ type: 'changed', what: 'threads' });
}

function touch(thread: Thread) {
  thread.updatedAt = Date.now();
  save('threads');
}

export function postMessage(thread: Thread, author: Message['author'], text: string, route_ = true): Message {
  const msg: Message = { id: newId('m'), threadId: thread.id, ts: Date.now(), author, parts: [{ type: 'text', text }], status: 'done' };
  messages(thread.id).push(msg);
  save(`messages/${thread.id}`);
  touch(thread);
  emit({ type: 'message', message: msg });
  if (route_) route(thread, msg);
  return msg;
}

function enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(threadId) || Promise.resolve()).then(fn, fn);
  queues.set(
    threadId,
    next.catch(() => {}),
  );
  return next;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentioned(thread: Thread, text: string): string[] {
  return thread.members.filter((id) => {
    const b = db.bots.find((x) => x.id === id);
    return b && new RegExp(`@${esc(b.name).replace(/\s+/g, '\\s*')}(?![\\w-])`, 'i').test(text);
  });
}

/** Decide which bots respond to a new message. */
function route(thread: Thread, msg: Message) {
  let targets: string[] = [];
  if (thread.kind === 'internal') return; // driven synchronously by ask_teammate
  if (thread.kind !== 'group') {
    if (msg.author.type !== 'bot') targets = thread.members.slice(0, 1);
  } else {
    targets = mentioned(thread, textOf(msg)).filter((id) => id !== msg.author.id);
    if (msg.author.type !== 'bot') {
      thread.hops = 0;
      if (!targets.length) targets = thread.members.slice(0, 1); // the first member acts as lead
    } else if (targets.length) {
      if (thread.hops >= MAX_HOPS) {
        postMessage(thread, { type: 'system', name: 'Crew' }, `Handoff limit reached (${MAX_HOPS} bot-to-bot turns). Reply to continue.`, false);
        return;
      }
      thread.hops += targets.length;
    }
  }
  for (const id of targets) void enqueue(thread.id, () => runBot(id, thread.id, 0));
}

async function delegate(from: Bot, name: string, message: string): Promise<string> {
  const to = db.bots.find((b) => b.id !== from.id && b.name.toLowerCase() === name.trim().replace(/^@/, '').toLowerCase());
  if (!to) return `No teammate named "${name}". Teammates: ${db.bots.filter((b) => b.id !== from.id).map((b) => b.name).join(', ') || '(none)'}`;
  const key = [from.id, to.id].sort();
  let thread = db.threads.find((t) => t.kind === 'internal' && t.members.length === 2 && [...t.members].sort().join() === key.join());
  if (!thread) {
    thread = { id: newId('t'), title: `${from.name} ↔ ${to.name}`, kind: 'internal', members: [from.id, to.id], createdAt: Date.now(), updatedAt: Date.now(), hops: 0 };
    db.threads.push(thread);
    save('threads');
    emit({ type: 'changed', what: 'threads' });
  }
  const t = thread;
  return enqueue(t.id, async () => {
    postMessage(t, { type: 'bot', id: from.id, name: from.name }, message, false);
    return (await runBot(to.id, t.id, 1)) || '(the teammate returned no text)';
  });
}

async function execTool(part: ToolPart, tools: Tool[], msg: Message, ctx: ToolCtx) {
  const update = () => emit({ type: 'message', message: msg });
  try {
    const tool = tools.find((t) => t.def.name === part.name);
    if (!tool) throw new Error(`Unknown tool "${part.name}".`);
    let args: any;
    try {
      args = JSON.parse(part.args || '{}');
    } catch {
      throw new Error('Tool arguments were not valid JSON.');
    }
    if (tool.risky && ctx.bot.policy === 'ask') {
      const id = newId('ap');
      part.status = 'approval';
      part.approvalId = id;
      const decision = await new Promise<'approve' | 'deny' | 'always'>((resolve) => {
        approvals.set(id, { id, botId: ctx.bot.id, threadId: ctx.thread.id, resolve });
        ctx.signal.addEventListener('abort', () => resolve('deny'), { once: true });
        update();
        emitStatus();
      });
      approvals.delete(id);
      delete part.approvalId;
      emitStatus();
      if (decision === 'always') {
        ctx.bot.policy = 'auto';
        save('bots');
        emit({ type: 'changed', what: 'bots' });
      } else if (decision === 'deny') {
        part.status = 'denied';
        part.result = 'The user denied this action. Do not retry it; ask what they would like instead.';
        return update();
      }
    }
    part.status = 'running';
    update();
    part.result = await tool.run(args, ctx);
    part.status = 'done';
  } catch (e: any) {
    part.status = 'error';
    part.result = `Error: ${e?.message || e}`;
  }
  update();
}

export async function runBot(botId: string, threadId: string, depth: number): Promise<string> {
  const bot = db.bots.find((b) => b.id === botId);
  const thread = db.threads.find((t) => t.id === threadId);
  if (!bot || !thread) return '';
  const msg: Message = { id: newId('m'), threadId, ts: Date.now(), author: { type: 'bot', id: bot.id, name: bot.name }, parts: [], status: 'streaming' };
  messages(threadId).push(msg);
  emit({ type: 'message', message: msg });
  const abort = new AbortController();
  running.set(msg.id, { abort, botId, threadId });
  emitStatus();

  try {
    const provider = db.config.providers.find((p) => p.id === bot.providerId);
    if (!provider) throw new Error(`${bot.name} has no model provider. Add one in Settings, then pick it in the bot's profile.`);
    await compact(bot, thread, provider, abort.signal).catch((e) => {
      if (abort.signal.aborted) throw e;
      console.error(`Could not summarise "${thread.title}": ${e?.message || e}`); // carry on with the capped window
    });
    const tools = toolsFor(bot, depth);
    const ctx: ToolCtx = { bot, thread, ws: wsDir(bot.id), signal: abort.signal, depth, delegate: (n, m) => delegate(bot, n, m) };
    const onDelta = (text: string) => {
      const last = msg.parts[msg.parts.length - 1];
      if (last?.type === 'text') last.text += text;
      else msg.parts.push({ type: 'text', text });
      emit({ type: 'delta', threadId, messageId: msg.id, text });
    };
    let step = 0;
    for (; step < MAX_STEPS; step++) {
      const res = await chat(provider, bot.model, buildContext(bot, thread), tools.map((t) => t.def), { signal: abort.signal, onDelta });
      if (!res.toolCalls.length) break;
      const parts: ToolPart[] = res.toolCalls.map((tc) => ({ type: 'tool', id: tc.id, name: tc.name, args: tc.args, status: 'pending' }));
      msg.parts.push(...parts);
      emit({ type: 'message', message: msg });
      for (const p of parts) {
        if (abort.signal.aborted) throw new Error('aborted');
        await execTool(p, tools, msg, ctx);
      }
      save(`messages/${threadId}`);
    }
    if (step === MAX_STEPS) onDelta(`\n\n_(Paused after ${MAX_STEPS} steps — reply "continue" to keep going.)_`);
    msg.status = 'done';
  } catch (e: any) {
    if (abort.signal.aborted) msg.status = 'stopped';
    else {
      msg.status = 'error';
      msg.error = e?.message || String(e);
    }
  } finally {
    running.delete(msg.id);
    save(`messages/${threadId}`);
    touch(thread);
    emit({ type: 'message', message: msg });
    emitStatus();
  }
  if (msg.status === 'done') route(thread, msg);
  return textOf(msg);
}

// ---------- Routines ----------

export function runRoutine(r: Routine) {
  const bot = db.bots.find((b) => b.id === r.botId);
  if (!bot) return;
  let thread = db.threads.find((t) => t.id === r.threadId);
  if (!thread) {
    thread = { id: newId('t'), title: r.name, kind: 'routine', members: [bot.id], createdAt: Date.now(), updatedAt: Date.now(), hops: 0 };
    db.threads.push(thread);
    r.threadId = thread.id;
    emit({ type: 'changed', what: 'threads' });
  }
  r.lastRun = Date.now();
  save('routines');
  save('threads');
  emit({ type: 'changed', what: 'routines' });
  postMessage(thread, { type: 'system', name: `Routine · ${r.name}` }, r.prompt);
  return thread.id;
}

export function cronMatch(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const vals = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  const min = [0, 0, 1, 1, 0];
  const max = [59, 23, 31, 12, 7];
  return f.every((field, i) =>
    field.split(',').some((part) => {
      const [range, stepS] = part.split('/');
      const step = Number(stepS) || 1;
      let lo = min[i];
      let hi = max[i];
      if (range !== '*') {
        const [a, b] = range.split('-').map(Number);
        if (Number.isNaN(a)) return false;
        lo = a;
        hi = b ?? (stepS ? max[i] : a);
      }
      const candidates = i === 4 && vals[i] === 0 ? [0, 7] : [vals[i]];
      return candidates.some((v) => v >= lo && v <= hi && (v - lo) % step === 0);
    }),
  );
}

export function startScheduler() {
  let lastKey = '';
  return setInterval(() => {
    const now = new Date();
    const key = now.toISOString().slice(0, 16);
    if (key === lastKey) return;
    lastKey = key;
    for (const r of db.routines) if (r.enabled && r.cron && cronMatch(r.cron, now)) runRoutine(r);
  }, 15000);
}
