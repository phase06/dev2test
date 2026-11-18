// Per-bot container isolation. Each isolated bot gets one long-lived container (Docker or Podman)
// with only its own workspace mounted, and its shell commands run there via `exec`.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { Bot } from './types';
import { HOME, db, wsDir } from './store';

let engine: string | null = null;
let version = '';
let checked = 0;

const sh = (cmd: string, args: string[], timeout = 60000) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    ),
  );
const eng = (args: string[], timeout?: number) => sh(engine!, args, timeout);

/** Look for a working container engine. Cheap to call often: results are cached for 15 s. */
export async function detectEngine(force = false) {
  if (!force && Date.now() - checked < 15000) return;
  checked = Date.now();
  const candidates = process.env.CREW_CONTAINER_ENGINE ? [process.env.CREW_CONTAINER_ENGINE] : ['docker', 'podman'];
  for (const c of candidates) {
    const r = await sh(c, ['version', '--format', '{{.Server.Version}}'], 8000);
    if (r.ok && r.out) {
      engine = c;
      version = r.out.split('\n')[0];
      return;
    }
  }
  engine = null;
  version = '';
}

export const sandboxInfo = () => ({ available: !!engine, engine: engine || '', version });

const rtLabel = crypto.createHash('sha1').update(HOME).digest('hex').slice(0, 12);
export const containerName = (botId: string) => `crew-${botId}`;

const starting = new Map<string, Promise<string>>();

/** Make sure the bot's container exists, matches the current settings and is running. */
export function ensureContainer(bot: Bot): Promise<string> {
  let p = starting.get(bot.id);
  if (!p) {
    p = create(bot).finally(() => starting.delete(bot.id));
    starting.set(bot.id, p);
  }
  return p;
}

async function create(bot: Bot): Promise<string> {
  await detectEngine();
  if (!engine)
    // Fail closed: an isolated bot must never silently fall back to the host.
    throw new Error(
      `${bot.name} is set to run in its own container, but no container engine (Docker or Podman) is running on this runtime. Start one, or switch ${bot.name} to "Host" in its profile.`,
    );
  const cfg = db.config.sandbox;
  const ws = wsDir(bot.id);
  const name = containerName(bot.id);
  const hash = crypto.createHash('sha1').update(JSON.stringify([cfg.image, cfg.network, cfg.asRoot, ws])).digest('hex').slice(0, 12);

  const ins = await eng(['inspect', '-f', '{{index .Config.Labels "crew.cfg"}} {{.State.Running}}', name]);
  if (ins.ok) {
    const [h, running] = ins.out.split(' ');
    if (h === hash) {
      if (running !== 'true') {
        const s = await eng(['start', name]);
        if (!s.ok) throw new Error(`Could not start ${bot.name}'s container: ${s.out}`);
      }
      return name;
    }
    await eng(['rm', '-f', name]); // settings changed: rebuild (the workspace is a mount, so nothing is lost)
  }

  const args = [
    'run', '-d', '--name', name, '--init',
    '--label', `crew.bot=${bot.id}`, '--label', `crew.cfg=${hash}`, '--label', `crew.rt=${rtLabel}`,
    '-v', `${ws}:/workspace`, '-w', '/workspace',
    '--security-opt', 'no-new-privileges', '--pids-limit', '1024',
  ];
  if (!cfg.network) args.push('--network', 'none');
  if (!cfg.asRoot && process.getuid) args.push('--user', `${process.getuid()}:${process.getgid!()}`, '-e', 'HOME=/tmp');
  args.push(cfg.image, 'sleep', 'infinity');
  const r = await eng(args, 15 * 60000); // the first run may pull the image
  if (!r.ok) throw new Error(`Could not create ${bot.name}'s container from image "${cfg.image}": ${r.out.slice(-600)}`);
  return name;
}

/**
 * Start a command inside the bot's container. The command gets its own process group whose id is
 * written to a pid file, so `kill()` can stop everything it spawned — killing the local `exec`
 * client alone would leave it running inside the container.
 */
export async function execInContainer(bot: Bot, command: string): Promise<{ child: ChildProcess; kill: () => void }> {
  const name = await ensureContainer(bot);
  const rid = crypto.randomBytes(5).toString('hex');
  const child = spawn(
    engine!,
    ['exec', '-w', '/workspace', '-e', `CREW_BOT=${bot.name}`, name, 'setsid', 'bash', '-c', 'echo $$ > /tmp/crew-$0.pid; exec bash -lc "$1"', rid, command],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const kill = () => {
    void eng(['exec', name, 'bash', '-c', `kill -9 -- -$(cat /tmp/crew-${rid}.pid)`], 10000).then(() => child.kill());
  };
  return { child, kill };
}

export async function removeContainer(botId: string) {
  if (engine) await eng(['rm', '-f', containerName(botId)]);
}

/** Stop this runtime's containers on shutdown (they restart on demand). */
export function stopContainers() {
  if (!engine) return;
  try {
    const ids = execFileSync(engine, ['ps', '-q', '--filter', `label=crew.rt=${rtLabel}`], { timeout: 5000 }).toString().split('\n').filter(Boolean);
    if (ids.length) execFileSync(engine, ['stop', '-t', '1', ...ids], { timeout: 20000 });
  } catch {
    /* best effort */
  }
}
