import { useEffect, useState } from 'react';
import { Client, TEMPLATES, type Bot, type Conn, type Runtime, type UiConfig } from './api';
import { Avatar, Field, Icon } from './ui';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
const TOOL_INFO: [keyof Bot['tools'], string, string][] = [
  ['shell', 'Terminal', 'Run shell commands on its computer'],
  ['files', 'Files', 'Read and write files in its workspace'],
  ['web', 'Web fetch', 'Download and read web pages'],
  ['browser', 'Browser', 'Drive a headless browser (needs Playwright on the host)'],
  ['mcp', 'Connectors', 'Use the MCP servers configured in Settings'],
  ['team', 'Delegation', 'Ask other teammates for help'],
  ['teamMemory', 'Team memory writer', 'Trusted to add notes to the shared team memory'],
];
const POLICIES: [Bot['policy'], string, string][] = [
  ['ask', 'Ask first', 'Pauses for your approval before commands, file changes and connector calls. Best on your own computer.'],
  ['auto', 'Autonomous', 'Acts without asking. Best on a dedicated VM, and required for unattended routines.'],
  ['readonly', 'Read-only', 'Can read, browse and think, but cannot run commands or change anything.'],
];

type Draft = Omit<Bot, 'id' | 'createdAt'>;
const blank = (rt: Runtime): Draft => ({
  name: '', role: '', instructions: '', color: COLORS[rt.bots.length % COLORS.length],
  providerId: rt.config?.providers[0]?.id || '', model: rt.config?.providers[0]?.models[0] || '',
  policy: 'ask', isolation: rt.info?.sandbox.available ? 'container' : 'host',
  tools: { shell: true, files: true, web: true, browser: false, mcp: true, team: true, teamMemory: false },
});

export function BotEditor({ rt, botId, others, onDone, onChat }: { rt: Runtime; botId: string | null; others: Conn[]; onDone: () => void; onChat: (bot: Bot) => void }) {
  const existing = rt.bots.find((b) => b.id === botId);
  const withDefaults = (b: Bot): Draft => ({ ...b, isolation: b.isolation ?? 'host', tools: { ...blank(rt).tools, ...b.tools } });
  const [d, setD] = useState<Draft>(existing ? withDefaults(existing) : blank(rt));
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [memory, setMemory] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; dir: boolean; size: number }[]>([]);
  useEffect(() => {
    setD(existing ? withDefaults(existing) : blank(rt));
    setErr('');
    setNote('');
    setMemory(null);
    if (!existing) return;
    fetch(rt.client.fileUrl(existing.id, 'MEMORY.md')).then((r) => (r.ok ? r.text() : '')).then(setMemory, () => setMemory(''));
    rt.client.get(`/api/bots/${existing.id}/files`).then(setFiles, () => setFiles([]));
  }, [botId, rt.client]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const provider = rt.config?.providers.find((p) => p.id === d.providerId);

  const saveBot = async () => {
    setErr('');
    try {
      const saved = existing ? await rt.client.put<Bot>(`/api/bots/${existing.id}`, d) : await rt.client.post<Bot>('/api/bots', d);
      if (existing && memory !== null) await rt.client.put(`/api/bots/${existing.id}/memory`, { text: memory });
      await rt.reload();
      if (existing) setNote('Saved.');
      else onChat(saved);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const remove = async () => {
    if (!existing || !confirm(`Remove ${existing.name}? Its chats and routines are deleted; its workspace files stay on disk.`)) return;
    await rt.client.del(`/api/bots/${existing.id}`);
    onDone();
  };
  const copyTo = async (conn: Conn) => {
    setErr('');
    setNote('');
    try {
      const target = new Client(conn);
      const cfg = await target.get<UiConfig>('/api/config');
      const match = cfg.providers.find((p) => p.id === d.providerId || p.name === provider?.name);
      await target.post('/api/bots', { ...d, providerId: match?.id ?? cfg.providers[0]?.id ?? '', policy: 'auto' });
      setNote(`Copied to ${conn.name}${match ? '' : ' — pick a model provider for it there'}. It starts with a fresh workspace and memory.`);
    } catch (e: any) {
      setErr(`Copy failed: ${e.message}`);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <Avatar name={d.name || '?'} bot={{ ...(d as Bot) }} size={40} />
        <div>
          <h1>{existing ? existing.name : 'New teammate'}</h1>
          <span>{existing ? `Lives on ${rt.info?.name}` : `Will run on ${rt.info?.name ?? rt.conn.name}`}</span>
        </div>
        <div className="spacer" />
        {existing && <button className="btn" onClick={() => onChat(existing)}><Icon name="chat" size={14} /> Message</button>}
      </header>

      {!existing && (
        <section>
          <h3>Start from a template</h3>
          <div className="chips">
            {TEMPLATES.filter((t) => !rt.bots.some((b) => b.name === t.name)).map((t) => (
              <button key={t.name} className={`chip ${d.role === t.role ? 'on' : ''}`} onClick={() => set({ name: t.name, role: t.role, instructions: t.instructions, tools: { ...d.tools, ...t.tools } })}>
                {t.role}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="grid2">
        <Field label="Name" hint="Teammates @mention each other by this name.">
          <input value={d.name} onChange={(e) => set({ name: e.target.value.replace(/[^\w-]/g, '') })} placeholder="Ada" />
        </Field>
        <Field label="Role">
          <input value={d.role} onChange={(e) => set({ role: e.target.value })} placeholder="Software engineer" />
        </Field>
      </section>
      <section>
        <Field label="Instructions" hint="How this teammate should work: responsibilities, standards, things to avoid.">
          <textarea rows={5} value={d.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
        <div className="swatches">
          {COLORS.map((c) => <button key={c} className={c === d.color ? 'on' : ''} style={{ background: c }} onClick={() => set({ color: c })} aria-label={`Colour ${c}`} />)}
        </div>
      </section>

      <section>
        <h3>Model</h3>
        {rt.config?.providers.length ? (
          <div className="grid2">
            <Field label="Provider">
              <select value={d.providerId} onChange={(e) => set({ providerId: e.target.value, model: rt.config!.providers.find((p) => p.id === e.target.value)?.models[0] || '' })}>
                {!provider && <option value="">Choose…</option>}
                {rt.config.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Model" hint="Pick from the provider's list or type any model id.">
              <input list="models" value={d.model} onChange={(e) => set({ model: e.target.value })} placeholder="model id" />
              <datalist id="models">{provider?.models.map((m) => <option key={m} value={m} />)}</datalist>
            </Field>
          </div>
        ) : (
          <p className="note">No model provider on this runtime yet — add one in Settings first.</p>
        )}
      </section>

      <section>
        <h3>Autonomy</h3>
        <div className="radio-cards">
          {POLICIES.map(([id, title, desc]) => (
            <label key={id} className={d.policy === id ? 'on' : ''}>
              <input type="radio" name="policy" checked={d.policy === id} onChange={() => set({ policy: id })} />
              <strong>{title}</strong>
              <span>{desc}</span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h3>Where it runs</h3>
        <div className="radio-cards two">
          <label className={d.isolation === 'container' ? 'on' : ''}>
            <input type="radio" name="isolation" checked={d.isolation === 'container'} onChange={() => set({ isolation: 'container' })} />
            <strong>Own container</strong>
            <span>Commands run in a private container that sees only this teammate's workspace — not your files, not other teammates.</span>
          </label>
          <label className={d.isolation === 'host' ? 'on' : ''}>
            <input type="radio" name="isolation" checked={d.isolation === 'host'} onChange={() => set({ isolation: 'host' })} />
            <strong>Host</strong>
            <span>Commands run directly on {rt.info?.name} as the runtime's user, with access to everything that user has.</span>
          </label>
        </div>
        {d.isolation === 'container' && !rt.info?.sandbox.available && <div className="note error">No container engine is running on {rt.info?.name}. Until Docker or Podman is started there, this teammate's commands will fail rather than run on the host.</div>}
        {d.isolation === 'host' && d.policy === 'auto' && <div className="note">Autonomous on the host: this teammate can run any command as your user without asking. Prefer a container, or a dedicated VM.</div>}
      </section>

      <section>
        <h3>Capabilities</h3>
        <div className="toggles">
          {TOOL_INFO.map(([k, title, desc]) => (
            <label key={k}>
              <input type="checkbox" checked={d.tools[k]} onChange={(e) => set({ tools: { ...d.tools, [k]: e.target.checked } })} />
              <span><strong>{title}</strong>{desc}</span>
            </label>
          ))}
        </div>
      </section>

      {existing && memory !== null && (
        <section>
          <h3>Memory</h3>
          <Field label="What this teammate remembers across conversations (MEMORY.md)">
            <textarea rows={4} value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="Nothing yet. It adds notes here as it learns your preferences; you can edit them." />
          </Field>
          <h3>Workspace</h3>
          {files.length ? (
            <ul className="files">
              {files.map((f) => (
                <li key={f.name}>
                  {f.dir ? <span>{f.name}/</span> : <a href={rt.client.fileUrl(existing.id, f.name)} target="_blank" rel="noreferrer">{f.name}</a>}
                  {!f.dir && <small>{f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}</small>}
                </li>
              ))}
            </ul>
          ) : <p className="note">Empty so far.</p>}
        </section>
      )}

      {err && <div className="note error">{err}</div>}
      {note && <div className="note ok">{note}</div>}
      <footer className="page-foot">
        <button className="btn primary" onClick={saveBot} disabled={!d.name}>{existing ? 'Save changes' : 'Add teammate'}</button>
        {!existing && <button className="btn ghost" onClick={onDone}>Cancel</button>}
        {existing && others.length > 0 && (
          <select className="btn" value="" onChange={(e) => { const c = others.find((o) => o.id === e.target.value); if (c) void copyTo(c); }}>
            <option value="">Copy to another runtime…</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <div className="spacer" />
        {existing && <button className="btn danger" onClick={remove}><Icon name="trash" size={14} /> Remove</button>}
      </footer>
    </div>
  );
}
