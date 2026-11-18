import { useEffect, useState } from 'react';
import { Client, PRESETS, type Conn, type McpServerCfg, type Provider, type Runtime } from './api';
import { Field, Icon, Modal } from './ui';

function ProviderModal({ rt, initial, onClose }: { rt: Runtime; initial: Provider | null; onClose: () => void }) {
  const [p, setP] = useState<Provider>(initial ?? { id: '', name: 'xAI', kind: PRESETS[0].kind, baseUrl: PRESETS[0].baseUrl, apiKey: '', models: [] });
  const [preset, setPreset] = useState(0);
  const [models, setModels] = useState(p.models.join(', '));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const current = (): Provider => ({ ...p, models: models.split(',').map((s) => s.trim()).filter(Boolean) });

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
    setBusy('');
  };
  const fetchModels = () =>
    run('models', async () => {
      const r = await rt.client.post<{ models: string[] }>('/api/providers/models', { provider: current() });
      setModels(r.models.join(', '));
      return `Found ${r.models.length} models.`;
    });
  const test = () =>
    run('test', async () => {
      const model = current().models[0];
      if (!model) throw new Error('Add at least one model id to test.');
      const r = await rt.client.post<{ reply: string }>('/api/providers/test', { provider: current(), model });
      return `${model} replied: “${r.reply.trim() || '(empty)'}”`;
    });
  const saveIt = async () => {
    const list = rt.config!.providers.filter((x) => x.id !== p.id);
    await rt.client.put('/api/config', { providers: [...list, current()] });
    await rt.reload();
    onClose();
  };

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add model provider'} onClose={onClose}>
      {!initial && (
        <Field label="Provider">
          <select value={preset} onChange={(e) => { const i = Number(e.target.value); const x = PRESETS[i]; setPreset(i); setP({ ...p, name: x.label.replace(/ \(.*/, ''), kind: x.kind, baseUrl: x.baseUrl }); setModels(x.models.join(', ')); }}>
            {PRESETS.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
          </select>
        </Field>
      )}
      <div className="grid2">
        <Field label="Name"><input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="API format">
          <select value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value as Provider['kind'] })}>
            <option value="openai">OpenAI-compatible (chat completions)</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </Field>
      </div>
      <Field label="Base URL" hint={p.kind === 'openai' ? 'The URL that /chat/completions is appended to — usually ends in /v1.' : 'The host that /v1/messages is appended to.'}>
        <input value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} placeholder="https://your-gateway.example.com/v1" />
      </Field>
      <Field label="API key" hint={`Stored only on the runtime “${rt.info?.name}”, never sent back to this app.`}>
        <input type="password" value={p.apiKey || ''} onChange={(e) => setP({ ...p, apiKey: e.target.value })} placeholder={p.hasKey ? 'Saved — leave blank to keep' : PRESETS[preset].keyHint} autoComplete="off" />
      </Field>
      <Field label="Models" hint="Comma-separated model ids offered when configuring a teammate.">
        <textarea rows={2} value={models} onChange={(e) => setModels(e.target.value)} placeholder="model-id-1, model-id-2" />
      </Field>
      <label className="check"><input type="checkbox" checked={p.stream !== false} onChange={(e) => setP({ ...p, stream: e.target.checked })} /> Stream responses <small>(turn off for gateways with broken tool-call streaming)</small></label>
      {msg && <div className={`note ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      <footer className="page-foot">
        <button className="btn primary" onClick={saveIt} disabled={!p.name || !p.baseUrl}>Save</button>
        <button className="btn" onClick={fetchModels} disabled={!!busy || !p.baseUrl}>{busy === 'models' ? 'Fetching…' : 'Fetch models'}</button>
        <button className="btn" onClick={test} disabled={!!busy || !p.baseUrl}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
      </footer>
    </Modal>
  );
}

function RuntimeModal({ onAdd, onClose }: { onAdd: (c: Conn) => Promise<void>; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const add = async () => {
    setErr('');
    try {
      // Accept the "Open:" link the runtime prints (http://host:4780/#token=…) as well as a bare URL.
      const m = /^(.*?)\/?#token=(.+)$/.exec(url.trim());
      const conn = { id: 'c' + Date.now().toString(36), name: '', url: (m ? m[1] : url).trim().replace(/\/+$/, ''), token: (m ? m[2] : token).trim() };
      const info = await new Client(conn).get('/api/info');
      await onAdd({ ...conn, name: info.name });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="Connect a remote runtime" onClose={onClose}>
      <p className="lede">Run the Crew runtime on any VM or server, then paste the link it prints. Teammates you create there keep working when this computer is asleep.</p>
      <pre className="code">{`# on the VM (Node 20+)\nnode crew-runtime.mjs --host 0.0.0.0 --name my-vm\n\n# safer: keep it on 127.0.0.1 and tunnel from here\nssh -N -L 4781:127.0.0.1:4780 user@my-vm`}</pre>
      <Field label="Runtime URL or the full “Open:” link"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:4781" autoFocus /></Field>
      {!url.includes('#token=') && <Field label="Access token" hint="Printed at startup, or run: node crew-runtime.mjs --token"><input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>}
      {err && <div className="note error">{err}</div>}
      <footer className="page-foot"><button className="btn primary" onClick={add} disabled={!url.trim()}>Connect</button></footer>
    </Modal>
  );
}

export function Settings({ rt, remotes, saveRemotes, homeId }: { rt: Runtime; remotes: Conn[]; saveRemotes: (l: Conn[]) => Promise<void>; homeId: string }) {
  const [editing, setEditing] = useState<Provider | null | 'new'>(null);
  const [adding, setAdding] = useState(false);
  const [mcp, setMcp] = useState<McpServerCfg[]>(rt.config?.mcpServers ?? []);
  const [mcpNote, setMcpNote] = useState('');
  const [name, setName] = useState(rt.info?.name ?? '');
  const [sb, setSb] = useState(rt.config?.sandbox);
  const [sbNote, setSbNote] = useState('');
  useEffect(() => {
    setMcp(rt.config?.mcpServers ?? []);
    setName(rt.info?.name ?? '');
    setSb(rt.config?.sandbox);
  }, [rt.conn.id, rt.config?.mcpServers.length, rt.info?.name, rt.config?.sandbox.image]);
  if (!rt.config) return <div className="page"><p className="note error">{rt.error || 'Loading…'}</p></div>;

  const removeProvider = async (p: Provider) => {
    if (!confirm(`Remove provider ${p.name}?`)) return;
    await rt.client.put('/api/config', { providers: rt.config!.providers.filter((x) => x.id !== p.id) });
    await rt.reload();
  };
  const saveMcp = async () => {
    setMcpNote('Starting servers…');
    try {
      await rt.client.put('/api/config', { mcpServers: mcp.filter((m) => m.name && m.command) });
      await rt.reload();
      setMcpNote('Saved.');
    } catch (e: any) {
      setMcpNote(e.message);
    }
  };

  return (
    <div className="page">
      <header className="page-head"><div><h1>Settings</h1><span>For the runtime “{rt.info?.name}” · {rt.info?.platform} · v{rt.info?.version}</span></div></header>

      <section>
        <div className="row-head"><h3>Model providers</h3><button className="btn sm" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> Add provider</button></div>
        <p className="lede">Any OpenAI-compatible or Anthropic-compatible endpoint works — hosted APIs, your company gateway, or local models. Each teammate picks its own provider and model.</p>
        <ul className="list">
          {rt.config.providers.map((p) => (
            <li key={p.id}>
              <div><strong>{p.name}</strong><small>{p.baseUrl} · {p.models.length ? `${p.models.length} models` : 'no models listed'}{p.hasKey ? '' : ' · no key'}</small></div>
              <button className="btn sm" onClick={() => setEditing(p)}>Edit</button>
              <button className="icon-btn" onClick={() => removeProvider(p)} aria-label={`Remove ${p.name}`}><Icon name="trash" size={14} /></button>
            </li>
          ))}
          {!rt.config.providers.length && <li className="empty">No providers yet.</li>}
        </ul>
      </section>

      <section>
        <div className="row-head"><h3>Runtimes</h3><button className="btn sm" onClick={() => setAdding(true)}><Icon name="plus" size={12} /> Connect remote</button></div>
        <p className="lede">A runtime is the computer teammates work on. This app ships with a local one; add remote VMs for always-on teammates. Switch between them in the top-left menu.</p>
        <ul className="list">
          <li><div><strong>{homeId === rt.conn.id ? rt.info?.name : 'Built-in runtime'}</strong><small>{location.origin} · built in</small></div></li>
          {remotes.map((c) => (
            <li key={c.id}>
              <div><strong>{c.name}</strong><small>{c.url}</small></div>
              <button className="icon-btn" onClick={() => confirm(`Disconnect ${c.name}? Its teammates keep running there.`) && saveRemotes(remotes.filter((x) => x.id !== c.id))} aria-label={`Disconnect ${c.name}`}><Icon name="trash" size={14} /></button>
            </li>
          ))}
        </ul>
        <div className="grid2" style={{ marginTop: 12 }}>
          <Field label="Name of this runtime">
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== rt.info?.name && rt.client.put('/api/config', { name }).then(rt.reload)} />
          </Field>
        </div>
      </section>

      {sb && (
        <section>
          <div className="row-head"><h3>Containers</h3><small className={rt.info?.sandbox.available ? '' : 'bad'}>{rt.info?.sandbox.available ? `${rt.info.sandbox.engine} ${rt.info.sandbox.version} is running` : 'No Docker or Podman found on this runtime'}</small></div>
          <p className="lede">Teammates set to “Own container” each get a private container with only their workspace mounted. Changes here rebuild containers on next use; workspaces are kept.</p>
          <Field label="Image" hint="Needs bash and coreutils. Anything installed outside /workspace is lost when the container is rebuilt, so bake tools into the image.">
            <input value={sb.image} onChange={(e) => setSb({ ...sb, image: e.target.value })} />
          </Field>
          <label className="check"><input type="checkbox" checked={sb.network} onChange={(e) => setSb({ ...sb, network: e.target.checked })} /> Allow network access from containers</label>
          <label className="check"><input type="checkbox" checked={sb.asRoot} onChange={(e) => setSb({ ...sb, asRoot: e.target.checked })} /> Run as root inside the container <small>(lets teammates install system packages)</small></label>
          <div className="page-foot"><button className="btn sm primary" onClick={() => rt.client.put('/api/config', { sandbox: sb }).then(() => (setSbNote('Saved.'), rt.reload()), (e) => setSbNote(e.message))}>Save container settings</button><small>{sbNote}</small></div>
        </section>
      )}

      <section>
        <div className="row-head"><h3>Connectors (MCP servers)</h3><button className="btn sm" onClick={() => setMcp([...mcp, { name: '', command: '', enabled: true }])}><Icon name="plus" size={12} /> Add server</button></div>
        <p className="lede">Stdio MCP servers started on this runtime. Their tools become available to teammates with “Connectors” enabled.</p>
        {mcp.map((m, i) => {
          const live = rt.info?.mcp.find((x) => x.name === m.name);
          const edit = (patch: Partial<McpServerCfg>) => setMcp(mcp.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div className="mcp-row" key={i}>
              <input type="checkbox" checked={m.enabled} onChange={(e) => edit({ enabled: e.target.checked })} aria-label="Enabled" />
              <input value={m.name} onChange={(e) => edit({ name: e.target.value.replace(/[^\w-]/g, '') })} placeholder="name" />
              <input value={m.command} onChange={(e) => edit({ command: e.target.value })} placeholder="npx -y @modelcontextprotocol/server-filesystem /data" />
              <small className={live?.status === 'error' ? 'bad' : ''} title={live?.error}>{live ? (live.status === 'ready' ? `${live.tools} tools` : live.status) : ''}</small>
              <button className="icon-btn" onClick={() => setMcp(mcp.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="x" size={14} /></button>
            </div>
          );
        })}
        {(mcp.length > 0 || rt.config.mcpServers.length > 0) && <div className="page-foot"><button className="btn sm primary" onClick={saveMcp}>Save connectors</button><small>{mcpNote}</small></div>}
      </section>

      {editing && <ProviderModal rt={rt} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {adding && <RuntimeModal onClose={() => setAdding(false)} onAdd={(c) => saveRemotes([...remotes, c])} />}
    </div>
  );
}
