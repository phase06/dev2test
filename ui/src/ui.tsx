import type { ReactNode } from 'react';
import type { Bot, BotStatus } from './api';

const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  gear: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4',
  clock: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  users: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3 3 0 100-6 3 3 0 000 6zM21 19v-1a4 4 0 00-3-3.85M15.5 4.15a3 3 0 010 5.7',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  chevron: 'M9 6l6 6-6 6',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01',
  chat: 'M20 15a2 2 0 01-2 2H8l-4 4V6a2 2 0 012-2h12a2 2 0 012 2z',
  link: 'M8 12h8M9 17H7a5 5 0 010-10h2M15 7h2a5 5 0 010 10h-2',
  play: 'M7 5l12 7-12 7z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Avatar({ bot, name, size = 28, status }: { bot?: Bot; name?: string; size?: number; status?: BotStatus }) {
  const label = bot?.name || name || '?';
  return (
    <span className="avatar" style={{ width: size, height: size, background: bot?.color || 'var(--avatar-neutral)', fontSize: size * 0.42 }}>
      {label[0]?.toUpperCase()}
      {status && status !== 'idle' && <span className={`avatar-dot ${status}`} title={status === 'approval' ? 'Needs your approval' : 'Working'} />}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export const timeAgo = (ts?: number) => {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
};
