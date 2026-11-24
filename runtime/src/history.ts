// Run history and settings change log: append-only JSON lines, one file per calendar month
// (history/YYYY-MM.jsonl in the runtime's data dir). Nothing here is ever rewritten, so the files
// double as an audit trail; delete old months by hand if they grow too large.
import fs from 'node:fs';
import path from 'node:path';
import type { Bot, Message, Thread } from './types';
import { HOME } from './store';

const DIR = path.join(HOME, 'history');
fs.mkdirSync(DIR, { recursive: true });

export interface RunRecord {
  type: 'run';
  id: string; // the reply's message id
  ts: number; // start
  end: number;
  botId: string;
  botName: string;
  threadId: string;
  threadTitle: string;
  threadKind: Thread['kind'];
  routineId?: string;
  routineName?: string;
  trigger: 'user' | 'routine' | 'teammate' | 'mention';
  status: 'done' | 'error' | 'stopped' | 'limited' | 'declined';
  error?: string;
  model?: string;
  usage?: Message['usage'];
  cost?: number;
  /** The conversation contained untrusted (outside) content during this run. */
  untrusted?: boolean;
  tools: { name: string; args: string; status: string; decision?: string; untrusted?: boolean }[];
}

export interface ChangeRecord {
  type: 'change';
  ts: number;
  action: string; // e.g. bot.update, config.update, routine.delete
  target?: string; // name of the teammate / routine / provider
  /** Field names that changed; for security-relevant fields, [old, new]. Never secrets. */
  fields: Record<string, unknown>;
}

export type HistoryRecord = RunRecord | ChangeRecord;

const monthOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const fileFor = (month: string) => path.join(DIR, `${month}.jsonl`);

export function record(r: HistoryRecord) {
  try {
    fs.appendFileSync(fileFor(monthOf(r.ts)), JSON.stringify(r) + '\n', { mode: 0o600 });
  } catch (e: any) {
    console.error(`Could not write history: ${e.message}`);
  }
}

export const months = () =>
  fs
    .readdirSync(DIR)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, 7))
    .sort()
    .reverse();

export function readMonth(month: string): HistoryRecord[] {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  try {
    return fs
      .readFileSync(fileFor(month), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return []; // a torn last line after a crash
        }
      });
  } catch {
    return [];
  }
}

export const exportPath = (month: string) => (/^\d{4}-\d{2}$/.test(month) && fs.existsSync(fileFor(month)) ? fileFor(month) : null);

/** Newest first, filtered, across months until `limit` records are found. */
export function query(o: { type?: 'run' | 'change'; botId?: string; before?: number; limit: number }): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  for (const m of months()) {
    const rows = readMonth(m)
      .filter((r) => (!o.type || r.type === o.type) && (!o.before || r.ts < o.before) && (!o.botId || (r.type === 'run' && r.botId === o.botId)))
      .sort((a, b) => b.ts - a.ts);
    for (const r of rows) {
      out.push(r);
      if (out.length >= o.limit) return out;
    }
  }
  return out;
}

/** Settings whose old and new values are worth keeping in the log (security- or cost-relevant). */
const SHOWN = new Set(['policy', 'isolation', 'guard', 'monthlyLimit', 'effort', 'model', 'providerId', 'tools', 'cron', 'enabled', 'name', 'sandbox', 'allowedOrigins']);

/** Changed fields between two versions of a setting; values only for fields in SHOWN. */
export function diff(before: Record<string, any> | undefined, after: Record<string, any>, keys: string[]) {
  const fields: Record<string, unknown> = {};
  for (const k of keys) {
    const a = before?.[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    fields[k] = SHOWN.has(k) ? [a ?? null, b ?? null] : 'changed';
  }
  return fields;
}

export function botFields(before: Bot | undefined, after: Bot) {
  return diff(before, after, Object.keys(after).filter((k) => k !== 'id' && k !== 'createdAt'));
}
