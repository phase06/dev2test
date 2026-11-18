import { db, flush, HOME, save } from './store';
import { createServer, VERSION } from './server';
import { startScheduler } from './agent';
import { stopMcp, syncMcp } from './mcp';
import { closeBrowser } from './tools';
import { detectEngine, stopContainers } from './sandbox';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('--help')) {
  console.log(`crew-runtime ${VERSION}

  --host <addr>   Interface to bind (default 127.0.0.1; use 0.0.0.0 on a VM)
  --port <n>      Port (default 4780; next free port is used if taken and --port is not given)
  --name <name>   Display name for this runtime
  --token         Print the access token and exit

Data lives in $CREW_HOME (default ~/.crew).`);
  process.exit(0);
}
if (argv.includes('--token')) {
  console.log(db.config.token);
  process.exit(0);
}
if (arg('name')) {
  db.config.name = arg('name')!;
  save('config');
}

const host = arg('host') || process.env.CREW_HOST || '127.0.0.1';
const fixedPort = arg('port') || process.env.CREW_PORT;
let port = fixedPort !== undefined ? Number(fixedPort) : 4780; // 0 = any free port

const server = createServer();
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && !fixedPort && port < 4800) return server.listen(++port, host);
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
});
server.on('listening', () => {
  port = (server.address() as { port: number }).port;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`Crew runtime "${db.config.name}" (${VERSION}) — data in ${HOME}`);
  console.log(`Listening on http://${host}:${port}`);
  console.log(`Open:  http://${shown}:${port}/#token=${db.config.token}`);
  if (host !== '127.0.0.1' && host !== 'localhost')
    console.log('Note: traffic is plain HTTP. Put this behind an SSH tunnel, VPN or TLS reverse proxy.');
  process.send?.({ ready: true, port, token: db.config.token });
});
server.listen(port, host);

void syncMcp(db.config.mcpServers);
void detectEngine();
startScheduler();

const shutdown = () => {
  flush();
  stopMcp();
  stopContainers();
  void closeBrowser().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
