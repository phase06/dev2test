// What model calls cost, and the monthly spending ledger that limits are enforced against.
import type { Bot, Ledger, Price, Provider, Routine, Usage } from './types';
import { db, save } from './store';

/**
 * Built-in prices, USD per million tokens, from Anthropic's published list (checked 2026-11).
 * Prices change: a provider's own `prices` entry overrides these, and models not listed here
 * (Grok, OpenAI, local models, ...) need one before their spending can be limited.
 * cacheRead defaults to 0.1x input and cacheWrite to 1.25x input (5-minute cache) when omitted.
 */
export const BUILTIN_PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 }, // prompts up to 100K tokens; $0.50 / $2.50 beyond
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Normalise ids like "anthropic/claude-opus-5-5" (OpenRouter) or "anthropic.claude-opus-5-5" (Bedrock). */
const bareModel = (model: string) => model.split('/').pop()!.replace(/^anthropic\./, '');

export function priceFor(provider: Provider | undefined, model: string): Price | null {
  return provider?.prices?.[model] ?? provider?.prices?.[bareModel(model)] ?? BUILTIN_PRICES[bareModel(model)] ?? null;
}

export function costOf(price: Price, u: Omit<Usage, 'calls'>): number {
  const read = price.cacheRead ?? price.input * 0.1;
  const write = price.cacheWrite ?? price.input * 1.25;
  return (u.input * price.input + u.output * price.output + u.cacheRead * read + u.cacheWrite * write) / 1e6;
}

// ---------- ledger ----------


const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function ledger(): Ledger {
  const m = monthOf();
  if (db.spend?.month !== m) {
    db.spend = { month: m, total: 0, bots: {}, routines: {}, unpriced: {} };
    save('spend');
  }
  return db.spend;
}

/** Record a call whose provider reported no usage, so it can't be priced or limited. */
export function chargeUnmetered(model: string) {
  const l = ledger();
  l.unmetered ??= {};
  l.unmetered[model] = (l.unmetered[model] ?? 0) + 1;
  save('spend');
}

/** Record one model call. Returns its cost in USD, or null when the model has no price. */
export function charge(provider: Provider | undefined, model: string, u: Omit<Usage, 'calls'>, botId: string, routineId?: string): number | null {
  const l = ledger();
  const price = priceFor(provider, model);
  if (!price) {
    l.unpriced[model] = (l.unpriced[model] ?? 0) + u.input + u.output + u.cacheRead + u.cacheWrite;
    save('spend');
    return null;
  }
  const c = costOf(price, u);
  l.total += c;
  l.bots[botId] = (l.bots[botId] ?? 0) + c;
  if (routineId) l.routines[routineId] = (l.routines[routineId] ?? 0) + c;
  save('spend');
  return c;
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/**
 * Why a call must not be made, or null if it may. Checked before every model call, so a run can
 * overshoot a limit by at most the one call that crossed it.
 */
export function overLimit(bot: Bot, routine?: Routine): string | null {
  const l = ledger();
  const cap = db.config.monthlyLimit;
  if (cap && l.total >= cap)
    return `Paused: this runtime reached its monthly spending limit (${usd(l.total)} of ${usd(cap)}). Raise it in Settings → Spending to continue.`;
  if (bot.monthlyLimit && (l.bots[bot.id] ?? 0) >= bot.monthlyLimit)
    return `Paused: ${bot.name} reached its monthly spending limit (${usd(l.bots[bot.id])} of ${usd(bot.monthlyLimit)}). Raise it in ${bot.name}'s profile to continue.`;
  if (routine?.monthlyLimit && (l.routines[routine.id] ?? 0) >= routine.monthlyLimit)
    return `Paused: the routine "${routine.name}" reached its monthly spending limit (${usd(l.routines[routine.id])} of ${usd(routine.monthlyLimit)}). Raise it in Routines to continue.`;
  return null;
}
