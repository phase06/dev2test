import { useEffect, useState } from 'react';
import { usd, type Runtime } from './api';
import type { HistoryRecord, RunRecord } from '../../runtime/src/history';
import { Avatar, Icon } from './ui';

const STATUS: Record<RunRecord['status'], string> = { done: 'Done', error: 'Error', stopped: 'Stopped', limited: 'Paused at limit', declined: 'Declined' };
const TRIGGER: Record<RunRecord['trigger'], string> = { user: 'You', routine: 'Routine', teammate: 'Delegated', mention: '@mention' };
const when = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);
const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function History({ rt, onOpenThread }: { rt: Runtime; onOpenThread: (id: string) => void }) {
  const [type, setType] = useState<'run' | 'change'>('run');
  const [bot, setBot] = useState('');
  const [rows, setRows] = useState<HistoryRecord[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');

  const load = async (before?: number) => {
    setErr('');
    try {
      const q = new URLSearchParams({ type, limit: '100', ...(bot && type === 'run' ? { bot } : {}), ...(before ? { before: String(before) } : {}) });
      const page = await rt.client.get<HistoryRecord[]>(`/api/history?${q}`);
      setRows((cur) => (before && cur ? [...cur, ...page] : page));
      setMore(page.length === 100);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    setRows(null);
    void load();
  }, [rt.client, type, bot, rt.status.threads.length]);

  const exportMonth = async () => {
    const month = new Date().toISOString().slice(0, 7);
    const text = await rt.client.text(`/api/history/${month}`);
    if (text === null) return setErr('Nothing recorded this month yet.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    a.download = `crew-history-${rt.info?.name ?? 'runtime'}-${month}.jsonl`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page wide">
      <header className="page-head">
        <div><h1>History</h1><span>Every run and settings change on “{rt.info?.name}”, newest first. Kept as monthly files in the runtime's data folder.</span></div>
        <div className="spacer" />
        <button className="btn sm" onClick={exportMonth}>Export this month</button>
      </header>
      <div className="toolbar">
        <div className="seg">
          <button className={type === 'run' ? 'on' : ''} onClick={() => setType('run')}>Runs</button>
          <button className={type === 'change' ? 'on' : ''} onClick={() => setType('change')}>Settings changes</button>
        </div>
        {type === 'run' && (
          <select value={bot} onChange={(e) => setBot(e.target.value)} aria-label="Teammate">
            <option value="">All teammates</option>
            {rt.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </div>
      {err && <div className="note error">{err}</div>}
      {rows === null ? <p className="note">Loading…</p> : !rows.length ? <p className="note">Nothing recorded yet.</p> : type === 'run' ? (
        <table className="history">
          <thead><tr><th>When</th><th>Teammate</th><th>Where</th><th>Started by</th><th>Outcome</th><th>Tools</th><th className="num">Cost</th><th className="num">Took</th></tr></thead>
          <tbody>
            {(rows as RunRecord[]).map((r) => {
              const b = rt.bots.find((x) => x.id === r.botId);
              const open = rt.threads.some((t) => t.id === r.threadId);
              const asked = r.tools.filter((t) => t.decision).length;
              return (
                <tr key={r.id} className={open ? 'link' : ''} onClick={() => open && onOpenThread(r.threadId)} title={r.error ?? ''}>
                  <td>{when(r.ts)}</td>
                  <td><span className="who"><Avatar bot={b} name={r.botName} size={20} />{r.botName}</span></td>
                  <td>{r.routineName ? `Routine · ${r.routineName}` : r.threadTitle}{r.untrusted && <span className="badge">web content</span>}</td>
                  <td>{TRIGGER[r.trigger]}</td>
                  <td className={`st ${r.status}`}>{STATUS[r.status]}</td>
                  <td>
                    {r.tools.length ? `${r.tools.length}` : '—'}
                    {asked > 0 && <small> · {asked} approval{asked > 1 ? 's' : ''}</small>}
                    {r.tools.some((t) => t.status === 'denied') && <small> · denied</small>}
                  </td>
                  <td className="num">{r.cost !== undefined ? usd(r.cost) : '—'}</td>
                  <td className="num">{dur(r.end - r.ts)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <table className="history">
          <thead><tr><th>When</th><th>Change</th><th>Of</th><th>What changed</th></tr></thead>
          <tbody>
            {rows.map((r) => r.type === 'change' && (
              <tr key={`${r.ts}-${r.action}`}>
                <td>{when(r.ts)}</td>
                <td>{r.action}</td>
                <td>{r.target ?? '—'}</td>
                <td className="fields">
                  {Object.entries(r.fields).map(([k, v]) => (
                    <div key={k}><code>{k}</code>{Array.isArray(v) && v.length === 2 && k !== 'providersAdded' && k !== 'providersRemoved' && k !== 'providersEdited' && k !== 'apiKeyChanged' ? <>: {fmt(v[0])} <Icon name="send" size={10} /> {fmt(v[1])}</> : v === 'changed' ? null : <>: {fmt(v)}</>}</div>
                  ))}
                  {!Object.keys(r.fields).length && '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {more && rows && <div className="page-foot"><button className="btn sm" onClick={() => load(rows.at(-1)!.ts)}>Older</button></div>}
    </div>
  );
}
