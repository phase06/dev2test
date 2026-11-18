import { useState } from 'react';
import type { Routine, Runtime } from './api';
import { Avatar, Field, Icon, Modal, timeAgo } from './ui';

const SCHEDULES: [string, string][] = [
  ['', 'Manual only'],
  ['0 * * * *', 'Every hour'],
  ['0 9 * * *', 'Every day at 09:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 9 * * 1', 'Mondays at 09:00'],
];
const describeCron = (c: string) => SCHEDULES.find(([v]) => v === c)?.[1] ?? `cron: ${c}`;

function RoutineModal({ rt, initial, onClose }: { rt: Runtime; initial: Routine | null; onClose: () => void }) {
  const [r, setR] = useState<Partial<Routine>>(initial ?? { name: '', botId: rt.bots[0]?.id, prompt: '', cron: '', enabled: true });
  const [custom, setCustom] = useState(!!initial && !SCHEDULES.some(([v]) => v === initial.cron));
  const [err, setErr] = useState('');
  const bot = rt.bots.find((b) => b.id === r.botId);
  const saveIt = async () => {
    try {
      if (initial) await rt.client.put(`/api/routines/${initial.id}`, r);
      else await rt.client.post('/api/routines', r);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={initial ? 'Edit routine' : 'New routine'} onClose={onClose}>
      <div className="grid2">
        <Field label="Name"><input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Morning metrics digest" autoFocus /></Field>
        <Field label="Teammate">
          <select value={r.botId} onChange={(e) => setR({ ...r, botId: e.target.value })}>
            {rt.bots.map((b) => <option key={b.id} value={b.id}>{b.name} — {b.role}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Instructions" hint="Written as a complete brief — each run starts from this text plus the routine's earlier runs.">
        <textarea rows={6} value={r.prompt} onChange={(e) => setR({ ...r, prompt: e.target.value })} />
      </Field>
      <div className="grid2">
        <Field label="Schedule" hint={`In the runtime's local time (${rt.info?.name}).`}>
          <select value={custom ? 'custom' : r.cron} onChange={(e) => { const v = e.target.value; setCustom(v === 'custom'); if (v !== 'custom') setR({ ...r, cron: v }); }}>
            {SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            <option value="custom">Custom cron…</option>
          </select>
        </Field>
        {custom && <Field label="Cron (min hour day month weekday)"><input value={r.cron} onChange={(e) => setR({ ...r, cron: e.target.value })} placeholder="*/30 9-17 * * 1-5" /></Field>}
      </div>
      {r.cron && bot?.policy === 'ask' && <div className="note">{bot.name} is set to “Ask first”, so scheduled runs will pause until you approve each action. Switch it to Autonomous for unattended runs.</div>}
      {err && <div className="note error">{err}</div>}
      <footer className="page-foot"><button className="btn primary" onClick={saveIt} disabled={!r.name || !r.prompt || !r.botId}>Save routine</button></footer>
    </Modal>
  );
}

export function Routines({ rt, onOpenThread }: { rt: Runtime; onOpenThread: (id: string) => void }) {
  const [editing, setEditing] = useState<Routine | null | 'new'>(null);
  const run = async (r: Routine) => onOpenThread((await rt.client.post<{ threadId: string }>(`/api/routines/${r.id}/run`)).threadId);
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Routines</h1><span>Repeatable work teammates do on a schedule or on demand — on “{rt.info?.name}”</span></div>
        <div className="spacer" />
        <button className="btn primary" disabled={!rt.bots.length} onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New routine</button>
      </header>
      <p className="lede">Teammates can also save routines themselves: after they finish a task, say “save this as a routine, weekdays at 9”.</p>
      <ul className="list">
        {rt.routines.map((r) => {
          const bot = rt.bots.find((b) => b.id === r.botId);
          return (
            <li key={r.id} className={r.enabled ? '' : 'off'}>
              <Avatar bot={bot} size={30} />
              <div>
                <strong>{r.name}</strong>
                <small>{bot?.name} · {describeCron(r.cron)}{r.enabled ? '' : ' · paused'} · last run {timeAgo(r.lastRun)}</small>
              </div>
              {r.cron && <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => rt.client.put(`/api/routines/${r.id}`, { enabled: e.target.checked })} /> On</label>}
              {r.threadId && <button className="btn sm" onClick={() => onOpenThread(r.threadId!)}>Runs</button>}
              <button className="btn sm" onClick={() => run(r)}><Icon name="play" size={11} /> Run now</button>
              <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>
              <button className="icon-btn" onClick={() => confirm(`Delete routine “${r.name}”?`) && rt.client.del(`/api/routines/${r.id}`)} aria-label={`Delete ${r.name}`}><Icon name="trash" size={14} /></button>
            </li>
          );
        })}
        {!rt.routines.length && <li className="empty">{rt.bots.length ? 'No routines yet.' : 'Add a teammate first.'}</li>}
      </ul>
      {editing && <RoutineModal rt={rt} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
