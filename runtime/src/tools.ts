import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Bot, Routine, Thread } from './types';
import type { ToolDef } from './providers';
import { db, emit, newId, safePath, save, setTeamMemory, teamMemory } from './store';
import { execInContainer } from './sandbox';
import { mcpClients } from './mcp';

export interface ToolCtx {
  bot: Bot;
  thread: Thread;
  ws: string;
  signal: AbortSignal;
  depth: number;
  delegate: (teammate: string, message: string) => Promise<string>;
}
export interface Tool {
  def: ToolDef;
  /** Risky tools need approval under the "ask" policy and are removed under "readonly". */
  risky?: boolean;
  run: (args: any, ctx: ToolCtx) => Promise<string>;
}

const MAX_OUT = 16000;
const clip = (s: string, max = MAX_OUT) =>
  s.length <= max ? s : s.slice(0, max / 2) + `\n…[${s.length - max} characters omitted]…\n` + s.slice(-max / 2);

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });

/** Resolve a path inside the bot's workspace; file tools may not leave it, even through symlinks. */
const inWs = (ws: string, p: string) => safePath(ws, p);

/** Collect a child's output with a timeout and Stop support; `kill` must end its whole process tree. */
function collect(child: ChildProcess, kill: () => void, ctx: ToolCtx, timeoutSec: number): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let note = '';
    const add = (d: Buffer) => {
      if (out.length < 400000) out += d.toString();
    };
    child.stdout!.on('data', add);
    child.stderr!.on('data', add);
    const stop = (why: string) => {
      note = why;
      try {
        kill();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => stop(`\n[killed: timed out after ${timeoutSec}s]`), timeoutSec * 1000);
    const onAbort = () => stop('\n[killed: stopped by user]');
    ctx.signal.addEventListener('abort', onAbort);
    const done = (code: number | null, err?: string) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve(clip(`${out}${note}${err ? '\n' + err : ''}\n[exit code: ${code ?? 'none'}]`.trim()));
    };
    child.on('error', (e) => done(null, `Failed to start shell: ${e.message}`));
    child.on('close', (code) => done(code));
  });
}

async function runShell(command: string, ctx: ToolCtx, timeoutSec: number): Promise<string> {
  if (ctx.bot.isolation === 'container') {
    const { child, kill } = await execInContainer(ctx.bot, command);
    return collect(child, kill, ctx, timeoutSec);
  }
  const win = process.platform === 'win32';
  const child = spawn(win ? 'powershell.exe' : 'bash', win ? ['-NoProfile', '-Command', command] : ['-lc', command], {
    cwd: ctx.ws,
    env: { ...process.env, CREW_BOT: ctx.bot.name },
    detached: !win,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collect(child, () => (win ? child.kill() : process.kill(-child.pid!, 'SIGKILL')), ctx, timeoutSec);
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

// --- Browser (optional: needs the `playwright` package on the runtime host) ---
let browserP: Promise<any> | undefined;
const pages = new Map<string, any>();
async function pageFor(botId: string) {
  let page = pages.get(botId);
  if (page && !page.isClosed()) return page;
  browserP ??= (async () => {
    let pw: any;
    try {
      pw = createRequire(import.meta.url)('playwright');
    } catch {
      throw new Error('The browser tool needs Playwright on this runtime: run `npm i -g playwright && npx playwright install chromium`.');
    }
    return pw.chromium.launch();
  })();
  browserP.catch(() => (browserP = undefined));
  const browser = await browserP;
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  pages.set(botId, page);
  return page;
}
export async function closeBrowser() {
  const b = await browserP?.catch(() => null);
  await b?.close().catch(() => {});
}

const shell: Tool = {
  risky: true,
  def: {
    name: 'shell',
    description:
      'Run a shell command on your computer (bash; PowerShell on a Windows host). The working directory is your workspace. Use it to run code, install packages, use git and CLIs, and inspect the system.',
    parameters: obj(
      { command: str('The command to run.'), timeout: { type: 'number', description: 'Seconds before the command is killed (default 120, max 900).' } },
      ['command'],
    ),
  },
  run: (a, ctx) => runShell(String(a.command), ctx, Math.min(Math.max(Number(a.timeout) || 120, 1), 900)),
};

const fileTools: Tool[] = [
  {
    def: {
      name: 'read_file',
      description: 'Read a text file from your workspace.',
      parameters: obj({ path: str('Path relative to the workspace.') }, ['path']),
    },
    run: async (a, ctx) => clip(await fs.readFile(inWs(ctx.ws, a.path), 'utf8'), 60000),
  },
  {
    def: {
      name: 'list_dir',
      description: 'List files in a workspace directory.',
      parameters: obj({ path: str('Directory relative to the workspace. Defaults to the workspace root.') }),
    },
    run: async (a, ctx) => {
      const entries = await fs.readdir(inWs(ctx.ws, a.path || '.'), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') || '(empty)';
    },
  },
  {
    risky: true,
    def: {
      name: 'write_file',
      description: 'Create or overwrite a text file in your workspace. Parent directories are created.',
      parameters: obj({ path: str('Path relative to the workspace.'), content: str('Full file content.') }, ['path', 'content']),
    },
    run: async (a, ctx) => {
      const f = inWs(ctx.ws, a.path);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, String(a.content));
      return `Wrote ${String(a.content).length} characters to ${a.path}`;
    },
  },
  {
    risky: true,
    def: {
      name: 'edit_file',
      description: 'Replace one exact occurrence of a string in a workspace file.',
      parameters: obj(
        { path: str('Path relative to the workspace.'), old_string: str('Exact text to replace; must occur once.'), new_string: str('Replacement text.') },
        ['path', 'old_string', 'new_string'],
      ),
    },
    run: async (a, ctx) => {
      const f = inWs(ctx.ws, a.path);
      const text = await fs.readFile(f, 'utf8');
      const n = text.split(a.old_string).length - 1;
      if (n !== 1) throw new Error(`old_string occurs ${n} times; it must occur exactly once.`);
      await fs.writeFile(f, text.replace(a.old_string, () => a.new_string));
      return `Edited ${a.path}`;
    },
  },
];

const remember: Tool = {
  def: {
    name: 'remember',
    description:
      'Save a durable note to your long-term memory (MEMORY.md): user preferences, facts about their projects, lessons learned. It is shown to you in every future conversation.',
    parameters: obj({ note: str('One concise fact or preference.') }, ['note']),
  },
  run: async (a, ctx) => {
    await fs.appendFile(inWs(ctx.ws, 'MEMORY.md'), `- ${String(a.note).trim()} (${new Date().toISOString().slice(0, 10)})\n`);
    return 'Saved to memory.';
  },
};

const rememberForTeam: Tool = {
  risky: true,
  def: {
    name: 'remember_for_team',
    description:
      'Add a note to the shared team memory (TEAM.md) that every teammate reads in every conversation. Only for durable facts the whole team needs: who the user is, projects, house rules. Personal working notes belong in remember.',
    parameters: obj({ note: str('One concise fact, written so any teammate understands it without context.') }, ['note']),
  },
  run: async (a, ctx) => {
    const cur = teamMemory();
    setTeamMemory(`${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}- ${String(a.note).trim()} (${ctx.bot.name}, ${new Date().toISOString().slice(0, 10)})\n`);
    return 'Added to team memory.';
  },
};

const saveRoutine: Tool = {
  def: {
    name: 'save_routine',
    description:
      'Save a repeatable workflow as a routine you will run again, on a schedule or on demand. Write the prompt as complete standalone instructions, including what you learned doing the task this time.',
    parameters: obj(
      {
        name: str('Short routine name.'),
        prompt: str('Standalone instructions for a future run.'),
        cron: str('Optional 5-field cron schedule in the runtime\'s local time, e.g. "0 9 * * 1-5". Omit for manual-only.'),
      },
      ['name', 'prompt'],
    ),
  },
  run: async (a, ctx) => {
    const r: Routine = { id: newId('rt'), name: String(a.name), botId: ctx.bot.id, prompt: String(a.prompt), cron: String(a.cron || ''), enabled: true };
    db.routines.push(r);
    save('routines');
    emit({ type: 'changed', what: 'routines' });
    return `Routine "${r.name}" saved${r.cron ? ` with schedule ${r.cron}` : ' (manual)'}.`;
  },
};

const webFetch: Tool = {
  def: {
    name: 'web_fetch',
    description: 'Fetch a URL and return its content as text (HTML is converted to plain text).',
    parameters: obj({ url: str('http(s) URL.') }, ['url']),
  },
  run: async (a, ctx) => {
    const r = await fetch(String(a.url), {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; CrewBot/0.1)' },
      redirect: 'follow',
    });
    const body = await r.text();
    const text = /html/i.test(r.headers.get('content-type') || '') ? htmlToText(body) : body;
    return clip(`HTTP ${r.status}\n\n${text}`);
  },
};

const browser: Tool = {
  def: {
    name: 'browser',
    description:
      'Drive your own headless browser for pages that need JavaScript or interaction. Actions: goto (url), text (read the visible page text), click (selector), type (selector, text, optional submit), screenshot (saved into your workspace).',
    parameters: obj(
      {
        action: { type: 'string', enum: ['goto', 'text', 'click', 'type', 'screenshot'] },
        url: str('For goto.'),
        selector: str('CSS or Playwright text selector, for click/type.'),
        text: str('Text to type.'),
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
      ['action'],
    ),
  },
  run: async (a, ctx) => {
    const page = await pageFor(ctx.bot.id);
    const summary = async () => `${await page.title()} — ${page.url()}\n\n${clip(await page.innerText('body').catch(() => ''), 6000)}`;
    switch (a.action) {
      case 'goto':
        await page.goto(String(a.url), { waitUntil: 'domcontentloaded', timeout: 45000 });
        return summary();
      case 'text':
        return summary();
      case 'click':
        await page.click(String(a.selector), { timeout: 15000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return summary();
      case 'type':
        await page.fill(String(a.selector), String(a.text ?? ''), { timeout: 15000 });
        if (a.submit) {
          await page.press(String(a.selector), 'Enter');
          await page.waitForLoadState('domcontentloaded').catch(() => {});
        }
        return summary();
      case 'screenshot': {
        const rel = `screenshots/shot-${Date.now()}.png`;
        const file = inWs(ctx.ws, rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file });
        return `Saved screenshot to ${rel}`;
      }
      default:
        throw new Error(`Unknown browser action: ${a.action}`);
    }
  },
};

const askTeammate: Tool = {
  def: {
    name: 'ask_teammate',
    description:
      'Delegate a task or question to another teammate and wait for their answer. They work on their own computer context and cannot see this conversation, so include everything they need.',
    parameters: obj({ teammate: str('Name of the teammate.'), message: str('The complete request.') }, ['teammate', 'message']),
  },
  run: (a, ctx) => ctx.delegate(String(a.teammate), String(a.message)),
};

export function toolsFor(bot: Bot, depth: number): Tool[] {
  const t: Tool[] = [remember, saveRoutine];
  if (bot.tools.teamMemory) t.push(rememberForTeam);
  if (bot.tools.shell) t.push(shell);
  if (bot.tools.files) t.push(...fileTools);
  if (bot.tools.web) t.push(webFetch);
  if (bot.tools.browser) t.push(browser);
  // Only top-level runs may delegate, which rules out delegation cycles.
  if (bot.tools.team && depth === 0 && db.bots.length > 1) t.push(askTeammate);
  if (bot.tools.mcp)
    for (const c of mcpClients())
      if (c.status === 'ready')
        for (const mt of c.tools)
          t.push({
            risky: true,
            def: {
              name: `mcp__${c.cfg.name}__${mt.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
              description: mt.description || mt.name,
              parameters: mt.inputSchema || obj({}),
            },
            run: (args) => c.call(mt.name, args),
          });
  return bot.policy === 'readonly' ? t.filter((x) => !x.risky) : t;
}
