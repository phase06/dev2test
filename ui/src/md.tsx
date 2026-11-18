import type { ReactNode } from 'react';

// A deliberately small Markdown renderer that builds React nodes (no innerHTML, so model output
// can never inject markup). Covers what chat replies use: code, headings, lists, emphasis, links.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>)\]]+)|(@[\w-]+)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const s = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{s.slice(2, -2)}</strong>);
    else if (m[3]) {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(s)!;
      out.push(<a key={k} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
    } else if (m[4]) out.push(<a key={k} href={s} target="_blank" rel="noreferrer noopener">{s}</a>);
    else if (m[5]) out.push(<span key={k} className="mention">{s}</span>);
    else out.push(<em key={k}>{s.slice(1, -1)}</em>);
    last = m.index! + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const key = () => `b${blocks.length}`;
  const flush = () => {
    if (para.length) blocks.push(<p key={key()}>{inline(para.join('\n'), key())}</p>);
    if (list) {
      const k = key();
      const items = list.items.map((it, i) => <li key={i}>{inline(it, `${k}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    }
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith('```'); i++) code.push(lines[i]);
      blocks.push(<pre key={key()}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push(<div key={key()} className={`md-h md-h${h[1].length}`}>{inline(h[2], key())}</div>);
    } else if (li) {
      if (para.length || (list && list.ordered !== !!li[2])) flush();
      list ??= { ordered: !!li[2], items: [] };
      list.items.push(li[3]);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="md">{blocks}</div>;
}
