// Tiny stdio MCP server used by the tests: one tool, `add`.
import readline from 'node:readline';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] });
  else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] });
});
