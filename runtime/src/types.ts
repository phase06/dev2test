export interface Provider {
  id: string;
  name: string;
  /** "openai" = any OpenAI-compatible /chat/completions endpoint (xAI, OpenAI, OpenRouter, Ollama, LM Studio, vLLM…) */
  kind: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  hasKey?: boolean;
  models: string[];
  headers?: Record<string, string>;
  stream?: boolean;
  maxTokens?: number;
  /**
   * Anthropic only: retry requests Claude declines on a fallback model (server-side fallbacks).
   * Default: on for api.anthropic.com, off for other hosts.
   */
  fallbacks?: boolean;
  /** USD per million tokens by model id, overriding the built-in table (runtime/src/pricing.ts). */
  prices?: Record<string, Price>;
}

export interface Price {
  input: number;
  output: number;
  /** Defaults to 0.1x input. */
  cacheRead?: number;
  /** Defaults to 1.25x input (5-minute cache). */
  cacheWrite?: number;
}

export interface McpServerCfg {
  name: string;
  /** Full command line of a stdio MCP server, e.g. "npx -y @modelcontextprotocol/server-filesystem /data" */
  command: string;
  enabled: boolean;
}

export interface Connection {
  id: string;
  name: string;
  url: string;
  token: string;
}

export interface Config {
  token: string;
  name: string;
  providers: Provider[];
  mcpServers: McpServerCfg[];
  /** Other runtimes this one's UI knows about (remote VMs). */
  connections: Connection[];
  sandbox: SandboxCfg;
  /** Estimated context size (tokens) above which older history, or older steps of a run, are summarised. */
  contextTokens: number;
  /** Monthly spending limit for the whole runtime, USD. Unset: no limit. */
  monthlyLimit?: number;
  /**
   * Browser origins, besides this runtime's own and loopback ones, allowed to call the API
   * (e.g. "https://crew-vm1.example.com" when another runtime's web UI manages this one).
   */
  allowedOrigins: string[];
}

export interface SandboxCfg {
  /** Image for isolated bots; needs bash and coreutils. */
  image: string;
  /** Whether containers get network access. */
  network: boolean;
  /** Run as root inside the container (lets bots apt-get install; on Linux, files they create are root-owned). */
  asRoot: boolean;
}

export type Policy = 'auto' | 'ask' | 'readonly';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface BotTools {
  shell: boolean;
  files: boolean;
  web: boolean;
  browser: boolean;
  mcp: boolean;
  team: boolean;
  /** Trusted to append to the shared TEAM.md. */
  teamMemory: boolean;
}

export interface Bot {
  id: string;
  name: string;
  color: string;
  role: string;
  instructions: string;
  providerId: string;
  model: string;
  policy: Policy;
  /** How hard the model thinks. Unset: the model's default (medium on Claude Opus 5.5). */
  effort?: Effort;
  /** Monthly spending limit for this teammate, USD. Unset: no limit. */
  monthlyLimit?: number;
  /**
   * Once a conversation contains untrusted content (web pages, browser, connector output), ask before
   * actions that change things or persist. Default on.
   */
  guard?: boolean;
  /** Where shell commands run: on the runtime host, or in this bot's own container. */
  isolation: 'host' | 'container';
  tools: BotTools;
  createdAt: number;
}

export interface Thread {
  id: string;
  title: string;
  kind: 'dm' | 'group' | 'routine' | 'internal';
  members: string[];
  createdAt: number;
  updatedAt: number;
  hops: number;
  /** Rolling summary of the first `count` messages, which are no longer replayed to the models. */
  summary?: { text: string; count: number };
  /** When untrusted content (web, browser, connector output) first entered this conversation. */
  untrustedSince?: number;
  /** The user chose "Allow for this conversation" on an untrusted-content approval. */
  guardOff?: boolean;
}

export type ToolStatus = 'pending' | 'approval' | 'running' | 'done' | 'error' | 'denied';

export type Part =
  | { type: 'text'; text: string }
  /** A progress note the model wrote between tool calls (shown to the user, not replayed as text). */
  | { type: 'note'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      args: string;
      result?: string;
      status: ToolStatus;
      approvalId?: string;
      images?: string[];
      /** The result came from outside (web, browser, connector): sent to the model as untrusted data. */
      untrusted?: boolean;
      /** Approval was required because the conversation contains untrusted content. */
      guard?: boolean;
    };

export interface Message {
  id: string;
  threadId: string;
  ts: number;
  author: { type: 'user' | 'bot' | 'system'; id?: string; name: string };
  parts: Part[];
  status: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  /** Index into `parts` where each model call of this run began. */
  stepStarts?: number[];
  /** Earlier steps of this run, folded into a summary: parts before `upTo` are no longer sent to the model. */
  runSummary?: { text: string; upTo: number };
  /** Fallback when summarising failed: tool outputs before this part index are no longer sent. */
  clearedUpTo?: number;
  usage?: Usage;
  /** What this run cost in USD, when the model's price is known. */
  cost?: number;
  /** Set when the run stopped at a spending limit; `status` is then 'error'. */
  limited?: boolean;
  /** Model the provider reported serving this run's last call, and why that call stopped. */
  model?: string;
  stopReason?: string;
  /** Set when the model declined; `status` is then 'error'. */
  refusal?: { category?: string | null; explanation?: string };
  /** Anthropic only: each step's original content blocks (thinking etc.), replayed verbatim. */
  raw?: { kind: 'anthropic'; steps: (unknown[] | null)[] };
}

/** Token usage, summed over every model call in a run. `input` excludes cache reads and writes. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}

export interface Routine {
  id: string;
  name: string;
  botId: string;
  prompt: string;
  /** 5-field cron in the runtime's local time; empty = manual only. */
  cron: string;
  enabled: boolean;
  threadId?: string;
  lastRun?: number;
  /** Monthly spending limit for this routine's runs, USD. Unset: no limit. */
  monthlyLimit?: number;
}

export type BotStatus = 'idle' | 'working' | 'approval';

export interface StatusSnapshot {
  bots: Record<string, BotStatus>;
  threads: string[];
}

export interface RuntimeInfo {
  name: string;
  version: string;
  platform: string;
  hostname: string;
  home: string;
  mcp: { name: string; status: string; tools: number; error?: string }[];
  sandbox: { available: boolean; engine: string; version: string };
}

export type ServerEvent =
  | { type: 'message'; message: Message }
  | { type: 'delta'; threadId: string; messageId: string; text: string }
  | { type: 'changed'; what: 'bots' | 'threads' | 'routines' | 'config' }
  | { type: 'status'; status: StatusSnapshot };

/** Spending this calendar month, USD (runtime/src/pricing.ts). */
export interface Ledger {
  /** Calendar month in the runtime's local time, e.g. "2026-11". Spending resets when it changes. */
  month: string;
  total: number;
  bots: Record<string, number>;
  routines: Record<string, number>;
  /** Models used this month with no known price: their spending is not counted or limited. */
  unpriced: Record<string, number>; // model -> tokens
  /** Models whose provider reported no token usage: calls counted, cost unknown. */
  unmetered?: Record<string, number>; // model -> calls
}
