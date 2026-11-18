import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot, Message, Part, Runtime, Thread } from './api';
import { Markdown } from './md';
import { Avatar, Icon } from './ui';

type ToolPart = Extract<Part, { type: 'tool' }>;

function describe(p: ToolPart): { label: string; detail: string } {
  let a: any = {};
  try {
    a = JSON.parse(p.args || '{}');
  } catch {
    /* show raw below */
  }
  switch (p.name) {
    case 'shell': return { label: 'Shell', detail: a.command || '' };
    case 'read_file': return { label: 'Read file', detail: a.path || '' };
    case 'write_file': return { label: 'Write file', detail: a.path || '' };
    case 'edit_file': return { label: 'Edit file', detail: a.path || '' };
    case 'list_dir': return { label: 'List files', detail: a.path || '.' };
    case 'web_fetch': return { label: 'Fetch page', detail: a.url || '' };
    case 'browser': return { label: `Browser · ${a.action}`, detail: a.url || a.selector || '' };
    case 'ask_teammate': return { label: `Ask ${a.teammate}`, detail: a.message || '' };
    case 'remember': return { label: 'Remember', detail: a.note || '' };
    case 'save_routine': return { label: 'Save routine', detail: `${a.name || ''}${a.cron ? ` · ${a.cron}` : ''}` };
    default: return { label: p.name.replace(/^mcp__/, '').replace(/__/g, ' · '), detail: p.args.length > 2 ? p.args : '' };
  }
}

const STATUS_TEXT: Record<ToolPart['status'], string> = {
  pending: 'queued', approval: 'needs approval', running: 'running…', done: '', error: 'failed', denied: 'denied',
};

function ToolCard({ part, rt, botId }: { part: ToolPart; rt: Runtime; botId?: string }) {
  const [open, setOpen] = useState(false);
  const { label, detail } = describe(part);
  const asking = part.status === 'approval';
  const decide = (decision: string) => rt.client.post(`/api/approvals/${part.approvalId}`, { decision }).catch(() => {});
  const shot = part.name === 'browser' && /Saved screenshot to (\S+)/.exec(part.result || '')?.[1];
  return (
    <div className={`tool ${part.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open || asking}>
        <span className={`chev ${open || asking ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>
        <span className="tool-label">{label}</span>
        <span className="tool-detail">{detail}</span>
        {STATUS_TEXT[part.status] && <span className="tool-status">{STATUS_TEXT[part.status]}</span>}
      </button>
      {(open || asking) && (
        <div className="tool-body">
          <pre>{part.name === 'shell' ? `$ ${detail}` : part.args}</pre>
          {part.result !== undefined && <pre className="tool-result">{part.result}</pre>}
        </div>
      )}
      {shot && botId && <img className="shot" src={rt.client.fileUrl(botId, shot)} alt="Browser screenshot" />}
      {asking && (
        <div className="approve">
          <button className="btn primary sm" onClick={() => decide('approve')}>Approve</button>
          <button className="btn sm" onClick={() => decide('deny')}>Deny</button>
          <button className="btn ghost sm" onClick={() => decide('always')} title="Switch this teammate to the Autonomous policy">Always allow for this teammate</button>
        </div>
      )}
    </div>
  );
}

function MessageRow({ m, rt, bot }: { m: Message; rt: Runtime; bot?: Bot }) {
  const working = m.status === 'streaming';
  return (
    <div className={`msg ${m.author.type}`}>
      {m.author.type === 'bot' ? <Avatar bot={bot} name={m.author.name} /> : <Avatar name={m.author.type === 'user' ? 'You' : '↻'} />}
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{m.author.name}</strong>
          {bot?.role && <span>{bot.role}</span>}
          <time>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        {m.parts.map((p, i) =>
          p.type === 'text' ? <Markdown key={i} text={p.text} /> : <ToolCard key={p.id + i} part={p} rt={rt} botId={m.author.id} />,
        )}
        {working && !m.parts.some((p) => p.type === 'tool' && p.status === 'approval') && <div className="typing"><i /><i /><i /></div>}
        {m.status === 'stopped' && <div className="note">Stopped.</div>}
        {m.status === 'error' && <div className="note error">{m.error}</div>}
      </div>
    </div>
  );
}

export function Chat({ rt, thread, onEditBot }: { rt: Runtime; thread: Thread; onEditBot: (id: string) => void }) {
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const members = thread.members.map((id) => rt.bots.find((b) => b.id === id)).filter(Boolean) as Bot[];
  const busy = rt.status.threads.includes(thread.id);

  useEffect(() => {
    setMsgs(null);
    setErr('');
    stick.current = true;
    let live = true;
    rt.client.get<Message[]>(`/api/threads/${thread.id}/messages`).then((m) => live && setMsgs(m), (e) => live && setErr(e.message));
    const off = rt.subscribe((e) => {
      if (e.type === 'message' && e.message.threadId === thread.id)
        setMsgs((cur) => {
          if (!cur) return cur;
          const i = cur.findIndex((x) => x.id === e.message.id);
          return i < 0 ? [...cur, e.message] : cur.map((x, j) => (j === i ? e.message : x));
        });
      else if (e.type === 'delta' && e.threadId === thread.id)
        setMsgs((cur) =>
          cur?.map((x) => {
            if (x.id !== e.messageId) return x;
            const parts = [...x.parts];
            const last = parts[parts.length - 1];
            if (last?.type === 'text') parts[parts.length - 1] = { ...last, text: last.text + e.text };
            else parts.push({ type: 'text', text: e.text });
            return { ...x, parts };
          }) ?? cur,
        );
    });
    input.current?.focus();
    return () => {
      live = false;
      off();
    };
  }, [rt.client, rt.subscribe, thread.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setErr('');
    stick.current = true;
    try {
      await rt.client.post(`/api/threads/${thread.id}/messages`, { text });
    } catch (e: any) {
      setErr(e.message);
      setDraft(text);
    }
  };

  const kind = { dm: 'Direct message', group: 'Group chat', routine: 'Routine runs', internal: 'Bot-to-bot delegation' }[thread.kind];
  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <h1>{thread.title}</h1>
          <span>{kind} · runs on {rt.info?.name ?? rt.conn.name}</span>
        </div>
        <div className="members">
          {members.map((b) => (
            <button key={b.id} className="member" onClick={() => onEditBot(b.id)} title={`${b.name} — ${b.role}`}>
              <Avatar bot={b} size={24} status={rt.status.bots[b.id]} />
              {members.length < 4 && <span>{b.name}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {msgs?.length === 0 && (
          <div className="empty-chat">
            <Avatar bot={members[0]} size={48} />
            <p>{thread.kind === 'group'
              ? `Give the team a goal. ${members[0]?.name} leads by default; @mention anyone to pull them in.`
              : `Give ${members[0]?.name} something to do. It works on its own computer and reports back.`}</p>
          </div>
        )}
        {msgs?.map((m, i) => (
          <Fragment key={m.id}>
            {thread.summary?.count === i && i > 0 && <div className="divider"><span>Teammates see a summary of everything above this line</span></div>}
            <MessageRow m={m} rt={rt} bot={rt.bots.find((b) => b.id === m.author.id)} />
          </Fragment>
        ))}
      </div>

      {thread.kind === 'internal' ? (
        <div className="composer-note">This thread shows teammates delegating to each other. It's read-only.</div>
      ) : (
        <div className="composer">
          {err && <div className="note error">{err}</div>}
          <div className="composer-box">
            <textarea
              ref={input}
              rows={1}
              value={draft}
              placeholder={thread.kind === 'group' ? 'Message the team — @mention to address someone' : `Message ${members[0]?.name ?? ''}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy && <button className="btn sm" onClick={() => rt.client.post(`/api/threads/${thread.id}/stop`)}><Icon name="stop" size={12} /> Stop</button>}
            <button className="btn primary sm" disabled={!draft.trim()} onClick={send} aria-label="Send"><Icon name="send" size={14} /></button>
          </div>
          {thread.kind === 'group' && (
            <div className="mention-chips">
              {members.map((b) => (
                <button key={b.id} onClick={() => { setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${b.name} `); input.current?.focus(); }}>@{b.name}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
