// Minimal MCP client over stdio: initialize, tools/list, tools/call.
import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerCfg } from './types';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  status: 'starting' | 'ready' | 'error' = 'starting';
  error?: string;
  tools: McpTool[] = [];
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = '';

  constructor(public cfg: McpServerCfg) {}

  async start() {
    try {
      this.proc = spawn(this.cfg.command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
      this.proc.on('error', (e) => this.fail(e.message));
      this.proc.on('exit', (code) => this.fail(`MCP server exited (code ${code})`));
      this.proc.stdout!.on('data', (d: Buffer) => this.onData(d.toString()));
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'crew', version: '0.1.0' },
      });
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const r = await this.request('tools/list', {});
      this.tools = r.tools || [];
      this.status = 'ready';
    } catch (e: any) {
      this.fail(e.message);
    }
  }

  private fail(msg: string) {
    if (this.status !== 'error') {
      this.status = 'error';
      this.error = msg;
    }
    for (const p of this.pending.values()) p.reject(new Error(msg));
    this.pending.clear();
  }

  private onData(s: string) {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'MCP error'));
        else p.resolve(m.result);
      } catch {
        /* non-JSON log line */
      }
    }
  }

  private send(m: unknown) {
    this.proc?.stdin?.write(JSON.stringify(m) + '\n');
  }

  private request(method: string, params: unknown, timeoutMs = 60000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async call(name: string, args: unknown): Promise<string> {
    const r = await this.request('tools/call', { name, arguments: args }, 300000);
    const text = (r.content || [])
      .map((c: any) => (c.type === 'text' ? c.text : `[${c.type} content]`))
      .join('\n');
    return (r.isError ? 'Error: ' : '') + text;
  }

  stop() {
    this.proc?.removeAllListeners('exit');
    this.proc?.kill();
  }
}

let clients: McpClient[] = [];

export async function syncMcp(servers: McpServerCfg[]) {
  clients.forEach((c) => c.stop());
  clients = servers.filter((s) => s.enabled && s.command.trim()).map((s) => new McpClient(s));
  await Promise.all(clients.map((c) => c.start()));
}

export const mcpClients = () => clients;
export const stopMcp = () => clients.forEach((c) => c.stop());
