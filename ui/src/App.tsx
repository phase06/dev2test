import { useEffect, useMemo, useState } from 'react';
import { Client, usd, useRuntime, type Bot, type Conn, type Runtime, type Thread, type UiConfig } from './api';
import { Chat } from './Chat';
import { BotEditor } from './BotEditor';
import { Settings } from './Settings';
import { Routines } from './Routines';
import { History } from './History';
import { Avatar, Field, Icon, Modal } from './ui';

type View = { type: 'home' } | { type: 'thread'; id: string } | { type: 'bot'; id: string | null } | { type: 'routines' } | { type: 'history' } | { type: 'settings' };

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function readToken() {
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (m) {
    ls.set('crew.token', decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname);
  }
  return ls.get('crew.token') || '';
}

export default function App() {
  const [token, setToken] = useState(readToken);
  const [input, setInput] = useState('');
  if (token) return <Shell token={token} onBadToken={() => setToken('')} />;
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Crew</h1>
        <p>Enter this runtime's access token. It is printed when the runtime starts, or run <code>crew-runtime --token</code>.</p>
        <input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Access token" autoFocus />
        <button className="btn primary" disabled={!input.trim()} onClick={() => { ls.set('crew.token', input.trim()); setToken(input.trim()); }}>Continue</button>
      </div>
    </div>
  );
}

function Shell({ token, onBadToken }: { token: string; onBadToken: () => void }) {
  const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const [homeName, setHomeName] = useState(isLocal ? 'This computer' : location.hostname);
  const home = useMemo<Conn>(() => ({ id: 'home', name: homeName, url: location.origin, token }), [token, homeName]);
  const homeClient = useMemo(() => new Client({ id: 'home', name: '', url: location.origin, token }), [token]);
  const [remotes, setRemotes] = useState<Conn[]>([]);
  const [activeId, setActiveId] = useState(() => ls.get('crew.active') || 'home');
  const [view, setView] = useState<View>({ type: 'home' });
  const [menu, setMenu] = useState(false);
  const [grouping, setGrouping] = useState(false);

  useEffect(() => {
    homeClient.get('/api/info').then((i) => setHomeName(i.name), () => {});
    homeClient.get<UiConfig>('/api/config').then((c) => setRemotes(c.connections), (e) => /token/i.test(e.message) && (ls.set('crew.token', ''), onBadToken()));
  }, [homeClient]);
  const saveRemotes = async (list: Conn[]) => {
    setRemotes(list);
    await homeClient.put('/api/config', { connections: list });
  };

  const conns = [home, ...remotes];
  const conn = conns.find((c) => c.id === activeId) ?? home;
  const rt = useRuntime(conn);
  const switchTo = (id: string) => {
    ls.set('crew.active', id);
    setActiveId(id);
    setView({ type: 'home' });
    setMenu(false);
  };

  const openDm = async (bot: Bot) => {
    const existing = rt.threads.find((t) => t.kind === 'dm' && t.members[0] === bot.id);
    const t = existing ?? (await rt.client.post<Thread>('/api/threads', { members: [bot.id] }));
    if (!existing) await rt.reload();
    setView({ type: 'thread', id: t.id });
  };
  const thread = view.type === 'thread' ? rt.threads.find((t) => t.id === view.id) : undefined;
  const threads = [...rt.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const waiting = Object.values(rt.status.bots).filter((s) => s === 'approval').length;

  return (
    <div className="app">
      <aside className="side">
        <div className="rt-switch">
          <button className="rt-current" onClick={() => setMenu(!menu)} aria-expanded={menu}>
            <span className={`dot ${rt.online ? 'on' : rt.loading ? '' : 'off'}`} />
            <span className="rt-name"><strong>{rt.info?.name ?? conn.name}</strong><small>{conn.id === 'home' ? (isLocal ? 'Local runtime' : 'This host') : 'Remote runtime'}{rt.online ? '' : rt.loading ? ' · connecting' : ' · offline'}</small></span>
            <Icon name="chevron" size={14} />
          </button>
          {menu && (
            <div className="rt-menu">
              {conns.map((c) => (
                <button key={c.id} className={c.id === conn.id ? 'on' : ''} onClick={() => switchTo(c.id)}>
                  <Icon name="server" size={14} />
                  <span>{c.name}<small>{c.id === 'home' ? (isLocal ? 'Local' : 'This host') : c.url}</small></span>
                </button>
              ))}
              <button onClick={() => { setMenu(false); setView({ type: 'settings' }); }}><Icon name="plus" size={14} /><span>Connect a remote VM…</span></button>
            </div>
          )}
        </div>

        <div className="side-scroll">
          <div className="side-head"><span>Teammates</span><button className="icon-btn" onClick={() => setView({ type: 'bot', id: null })} aria-label="Add teammate" title="Add teammate"><Icon name="plus" size={14} /></button></div>
          {rt.bots.map((b) => {
            const st = rt.status.bots[b.id] ?? 'idle';
            return (
              <div key={b.id} className={`row ${thread?.kind === 'dm' && thread.members[0] === b.id ? 'on' : ''}`}>
                <button className="row-main" onClick={() => openDm(b)}>
                  <Avatar bot={b} status={st} />
                  <span className="row-text"><strong>{b.name}</strong><small>{st === 'approval' ? 'Needs your approval' : st === 'working' ? 'Working…' : b.role || 'Teammate'}</small></span>
                </button>
                <button className="icon-btn hover" onClick={() => setView({ type: 'bot', id: b.id })} aria-label={`Edit ${b.name}`}><Icon name="gear" size={14} /></button>
              </div>
            );
          })}
          {!rt.bots.length && !rt.loading && <p className="side-empty">No teammates on this runtime yet.</p>}

          <div className="side-head"><span>Threads</span><button className="icon-btn" disabled={rt.bots.length < 2} onClick={() => setGrouping(true)} aria-label="New group chat" title={rt.bots.length < 2 ? 'Add two teammates to start a group chat' : 'New group chat'}><Icon name="users" size={14} /></button></div>
          {threads.filter((t) => t.kind !== 'dm').map((t) => (
            <div key={t.id} className={`row ${thread?.id === t.id ? 'on' : ''}`}>
              <button className="row-main" onClick={() => setView({ type: 'thread', id: t.id })}>
                <span className="thread-ico"><Icon name={t.kind === 'group' ? 'users' : t.kind === 'routine' ? 'clock' : 'link'} size={14} /></span>
                <span className="row-text"><strong>{t.title}</strong><small>{rt.status.threads.includes(t.id) ? 'Working…' : t.kind === 'group' ? `${t.members.length} teammates` : t.kind === 'routine' ? 'Routine runs' : 'Delegation'}</small></span>
              </button>
              <button className="icon-btn hover" onClick={async () => { if (!confirm(`Delete “${t.title}” and its history?`)) return; await rt.client.del(`/api/threads/${t.id}`); if (thread?.id === t.id) setView({ type: 'home' }); }} aria-label={`Delete ${t.title}`}><Icon name="x" size={14} /></button>
            </div>
          ))}
          {!threads.some((t) => t.kind !== 'dm') && <p className="side-empty">Group chats, routine runs and delegations appear here.</p>}
        </div>

        <nav className="side-nav">
          <button className={view.type === 'home' ? 'on' : ''} onClick={() => setView({ type: 'home' })}><Icon name="users" /> Team{waiting > 0 && <b>{waiting}</b>}</button>
          <button className={view.type === 'routines' ? 'on' : ''} onClick={() => setView({ type: 'routines' })}><Icon name="clock" /> Routines</button>
          <button className={view.type === 'history' ? 'on' : ''} onClick={() => setView({ type: 'history' })}><Icon name="list" /> History</button>
          <button className={view.type === 'settings' ? 'on' : ''} onClick={() => setView({ type: 'settings' })}><Icon name="gear" /> Settings</button>
        </nav>
      </aside>

      <main onClick={() => menu && setMenu(false)}>
        {!rt.online && !rt.loading && <div className="banner">Can't reach “{conn.name}” ({conn.url}). {rt.error} <button className="btn sm" onClick={rt.reload}>Retry</button></div>}
        {view.type === 'thread' && thread ? <Chat rt={rt} thread={thread} onEditBot={(id) => setView({ type: 'bot', id })} />
          : view.type === 'bot' ? <BotEditor rt={rt} botId={view.id} others={conns.filter((c) => c.id !== conn.id)} onDone={() => setView({ type: 'home' })} onChat={(b) => void openDm(b)} />
          : view.type === 'routines' ? <Routines rt={rt} onOpenThread={async (id) => { await rt.reload(); setView({ type: 'thread', id }); }} />
          : view.type === 'history' ? <History rt={rt} onOpenThread={(id) => setView({ type: 'thread', id })} />
          : view.type === 'settings' ? <Settings rt={rt} remotes={remotes} saveRemotes={saveRemotes} homeId="home" />
          : <Home rt={rt} go={setView} openDm={openDm} />}
      </main>

      {grouping && <GroupModal rt={rt} onClose={() => setGrouping(false)} onCreated={async (t) => { await rt.reload(); setGrouping(false); setView({ type: 'thread', id: t.id }); }} />}
    </div>
  );
}

function TeamMemory({ rt }: { rt: Runtime }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    setText(null);
    rt.client.get<{ text: string }>('/api/team-memory').then((r) => (setText(r.text), setSaved(r.text)), () => {});
  }, [rt.client]);
  if (text === null) return null;
  return (
    <section className="team-memory">
      <h3>Team memory</h3>
      <p className="lede">Shared context every teammate on {rt.info?.name} reads in every conversation: who you are, your projects, house rules. You write it; only teammates you mark as “Team memory writer” can add to it.</p>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'- We are a 5-person fintech startup; I am the CTO.\n- Code lives in GitHub org acme; Python 3.12, pytest.\n- Never email customers without my sign-off.'} />
      <div className="page-foot">
        <button className="btn primary sm" disabled={text === saved} onClick={() => rt.client.put('/api/team-memory', { text }).then(() => setSaved(text))}>Save team memory</button>
        <small>{text === saved ? (saved ? 'Saved' : '') : 'Unsaved changes'}{text.length > 6000 ? ' · only the last 6,000 characters are shown to teammates' : ''}</small>
      </div>
    </section>
  );
}

function Home({ rt, go, openDm }: { rt: Runtime; go: (v: View) => void; openDm: (b: Bot) => void }) {
  if (rt.loading) return <div className="page"><p className="note">Connecting…</p></div>;
  const hasProvider = !!rt.config?.providers.length;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Your team on {rt.info?.name ?? rt.conn.name}</h1><span>Teammates work on this runtime's computer: its terminal, files and browser.</span></div></header>
      {(!hasProvider || !rt.bots.length) && rt.online && (
        <ol className="steps">
          <li className={hasProvider ? 'done' : ''}>
            <div><strong>Connect a model</strong><span>Grok, Claude, GPT, a company gateway, or a local model — anything OpenAI- or Anthropic-compatible.</span></div>
            <button className={`btn ${hasProvider ? '' : 'primary'}`} onClick={() => go({ type: 'settings' })}>{hasProvider ? 'Manage' : 'Add provider'}</button>
          </li>
          <li>
            <div><strong>Add your first teammate</strong><span>Give it a role, a model and a level of autonomy.</span></div>
            <button className={`btn ${hasProvider ? 'primary' : ''}`} disabled={!hasProvider} onClick={() => go({ type: 'bot', id: null })}>Add teammate</button>
          </li>
        </ol>
      )}
      <div className="cards">
        {rt.bots.map((b) => {
          const st = rt.status.bots[b.id] ?? 'idle';
          const prov = rt.config?.providers.find((p) => p.id === b.providerId);
          return (
            <div key={b.id} className="card">
              <div className="card-top"><Avatar bot={b} size={40} status={st} /><div><strong>{b.name}</strong><span>{b.role}</span></div></div>
              <dl>
                <dt>Status</dt><dd className={st}>{st === 'approval' ? 'Needs your approval' : st === 'working' ? 'Working' : 'Idle'}</dd>
                <dt>Model</dt><dd>{prov ? `${b.model || '—'} · ${prov.name}` : 'No provider'}</dd>
                <dt>Autonomy</dt><dd>{{ ask: 'Asks first', auto: 'Autonomous', readonly: 'Read-only' }[b.policy]}</dd>
                <dt>Runs in</dt><dd>{b.isolation === 'container' ? 'Own container' : 'Host'}</dd>
                <dt>This month</dt>
                <dd className={b.monthlyLimit && (rt.spend?.bots[b.id] ?? 0) >= b.monthlyLimit * 0.8 ? 'approval' : ''}>
                  {rt.spend?.unpricedBots.includes(b.id) ? 'Not tracked (no price for this model)' : `${usd(rt.spend?.bots[b.id] ?? 0)}${b.monthlyLimit ? ` of ${usd(b.monthlyLimit)}` : ''}`}
                </dd>
              </dl>
              <div className="card-actions"><button className="btn primary sm" onClick={() => openDm(b)}>Message</button><button className="btn sm" onClick={() => go({ type: 'bot', id: b.id })}>Profile</button></div>
            </div>
          );
        })}
        {rt.bots.length > 0 && <button className="card add" onClick={() => go({ type: 'bot', id: null })}><Icon name="plus" size={20} />Add teammate</button>}
      </div>
      {rt.online && <TeamMemory rt={rt} />}
    </div>
  );
}

function GroupModal({ rt, onClose, onCreated }: { rt: Runtime; onClose: () => void; onCreated: (t: Thread) => void }) {
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const lead = rt.bots.find((b) => b.id === picked[0]);
  return (
    <Modal title="New group chat" onClose={onClose}>
      <Field label="Topic"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Q3 launch" autoFocus /></Field>
      <span className="field-label">Teammates</span>
      <div className="toggles">
        {rt.bots.map((b) => (
          <label key={b.id}>
            <input type="checkbox" checked={picked.includes(b.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, b.id] : picked.filter((x) => x !== b.id))} />
            <span><strong>{b.name}</strong>{b.role}</span>
          </label>
        ))}
      </div>
      <p className="lede">{lead ? `${lead.name} leads: it answers messages that don't @mention anyone and can hand work to the others.` : 'The first teammate you pick leads the chat.'}</p>
      <footer className="page-foot"><button className="btn primary" disabled={picked.length < 2} onClick={async () => onCreated(await rt.client.post<Thread>('/api/threads', { title, members: picked }))}>Create</button></footer>
    </Modal>
  );
}
