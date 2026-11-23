// A scripted OpenAI-compatible provider, so the runtime can be exercised without an API key.
//   node test/mock-provider.mjs [port]
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const q0 = (m) => (typeof m.content === 'string' ? m.content : '').toLowerCase();

function decide(body) {
  const sys = body.messages.find((m) => m.role === 'system')?.content || '';
  const me = /You are ([\w-]+)/.exec(sys)?.[1] || 'Bot';
  const last = body.messages[body.messages.length - 1];
  const has = (n) => (body.tools || []).some((t) => t.function.name === n);
  const call = (name, args) => ({ tool: { name, args: JSON.stringify(args) } });
  if (sys.startsWith('You maintain a running summary')) return { text: 'SUMMARY: the user prefers teal and the launch is on Friday.' };
  const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')) || '';
  const images = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image_url') : []));
  if (body.model === 'blind' && images.length) return { status: 400, error: 'image input is not supported by this model' };
  // "loop N": call the shell N times with bulky output, surviving in-run summaries.
  const reqIdx = body.messages.findLastIndex((m) => m.role === 'user' && /loop \d+/.test(textOf(m)));
  if (reqIdx >= 0) {
    const goal = Number(/loop (\d+)/.exec(textOf(body.messages[reqIdx]))[1]);
    const after = body.messages.slice(reqIdx + 1);
    const done = Math.max(0, ...after.map((m) => Number((m.role === 'tool' ? / step (\d+)\n/ : /PROGRESS: completed (\d+) steps/).exec(textOf(m))?.[1] ?? 0)));
    if (textOf(last).startsWith('Pause the task.')) return { text: `PROGRESS: completed ${done} steps of ${goal}.` };
    if (last.role === 'tool' || last.role === 'user') return done < goal ? call('shell', { command: `printf 'x%.0s' $(seq 1 2000); echo " step ${done + 1}"` }) : { text: `Finished all ${goal} steps.` };
  }
  const fetchUrl = /fetch (https?:\/\/\S+)/.exec(textOf(last))?.[1];
  if (fetchUrl && last.role === 'user' && has('web_fetch')) return call('web_fetch', { url: fetchUrl });
  if (q0(last).includes('look at') && has('read_file')) return call('read_file', { path: /look at (\S+)/.exec(textOf(last))[1] });
  if (last.role === 'user' && Array.isArray(last.content) && images.length) return { text: `I can see ${images.length} image(s).` };
  if (last.role === 'tool') return { text: `Done. Result:\n\n\`\`\`\n${String(last.content).slice(0, 200)}\n\`\`\`` };
  const raw = /sh(?:\[(\d+)\])?: ([\s\S]+)$/.exec(String(last.content || ''));
  if (raw && has('shell')) return call('shell', { command: raw[2], ...(raw[1] ? { timeout: Number(raw[1]) } : {}) });
  const q = String(last.content || '').toLowerCase();
  const section = (h) => new RegExp(`## ${h}\\n([\\s\\S]*?)(?=\\n\\n## |$)`).exec(sys)?.[1] ?? 'nothing';
  if (q.includes('recall')) return { text: `EARLIER: ${section('Earlier in this conversation')} TEAM: ${section('Team memory')}` };
  if (q.includes('team note') && has('remember_for_team')) return call('remember_for_team', { note: 'Deploys happen on Tuesdays' });
  if (q.includes('add up') && has('mcp__calc__add')) return call('mcp__calc__add', { a: 2, b: 3 });
  if (q.includes('run ') && has('shell')) return call('shell', { command: 'echo hello-from-$CREW_BOT' });
  if (q.includes('write') && has('write_file')) return call('write_file', { path: 'note.txt', content: 'hi from ' + me });
  if (q.includes('delegate') && has('ask_teammate')) return call('ask_teammate', { teammate: 'Rex', message: 'What is 2+2?' });
  if (q.includes('2+2')) return { text: 'It is 4.' };
  if (q.includes('handoff') && me !== 'Rex') return { text: 'I drafted the plan. @Rex please review it.' };
  if (q.includes('please review')) return { text: 'Reviewed — **looks good**, ship it.' };
  return { text: `Hello from ${me} using ${body.model}.` };
}

export function startMock(port = 0) {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }] }));
    }
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', async () => {
      const body = JSON.parse(data);
      server.requests.push(body);
      server.headers.push(req.headers);
      const d = decide(body);
      if (d.status) {
        res.writeHead(d.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: d.error } }));
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        const message = d.tool
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: d.tool.name, arguments: d.tool.args } }] }
          : { role: 'assistant', content: d.text };
        return res.end(JSON.stringify({ choices: [{ message }] }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      if (d.tool) {
        const id = 'call_' + Math.random().toString(36).slice(2, 10);
        const half = Math.ceil(d.tool.args.length / 2);
        send({ tool_calls: [{ index: 0, id, type: 'function', function: { name: d.tool.name, arguments: '' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: d.tool.args.slice(0, half) } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: d.tool.args.slice(half) } }] });
      } else {
        for (const w of d.text.match(/\S+\s*/g) || []) {
          send({ content: w });
          await new Promise((r) => setTimeout(r, 8));
        }
      }
      if (body.stream_options?.include_usage)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  server.requests = [];
  server.headers = [];
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startMock(Number(process.argv[2]) || 4999);
  console.log(`Mock provider on http://127.0.0.1:${s.address().port}/v1`);
}
