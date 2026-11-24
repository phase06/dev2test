import fs from 'node:fs';
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

  --host <addr>          Interface to bind (default 127.0.0.1)
  --port <n>             Port (default 4780; next free port is used if taken and --port is not given)
  --name <name>          Display name for this runtime
  --tls-cert <file>      Serve HTTPS with this certificate (PEM; also CREW_TLS_CERT)
  --tls-key <file>       ...and this private key (PEM; also CREW_TLS_KEY)
  --allow-origin <url>   Let a browser on this origin call the API (repeatable; also CREW_ALLOWED_ORIGINS)
  --allow-insecure-http  Allow plain HTTP on a non-loopback address (only behind a TLS proxy,
                         a VPN, or a container port published on 127.0.0.1)
  --token                Print the access token and exit

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

for (let i = 0; i < argv.length; i++)
  if (argv[i] === '--allow-origin' && argv[i + 1] && !db.config.allowedOrigins.includes(argv[i + 1])) {
    db.config.allowedOrigins.push(argv[i + 1].replace(/\/+$/, ''));
    save('config');
  }

const host = arg('host') || process.env.CREW_HOST || '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
const certFile = arg('tls-cert') || process.env.CREW_TLS_CERT;
const keyFile = arg('tls-key') || process.env.CREW_TLS_KEY;
if (!!certFile !== !!keyFile) {
  console.error('Could not start: --tls-cert and --tls-key go together.');
  process.exit(1);
}
const tls = certFile && keyFile ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) } : undefined;
const insecureOk = argv.includes('--allow-insecure-http') || process.env.CREW_ALLOW_INSECURE_HTTP === '1';
if (!loopback && !tls && !insecureOk) {
  // The access token would cross the network in plain text.
  console.error(`Refusing to serve plain HTTP on ${host}: the access token would cross the network unencrypted.
Use --tls-cert/--tls-key, keep --host 127.0.0.1 and reach it over SSH or a VPN, or put it behind a
TLS reverse proxy and pass --allow-insecure-http.`);
  process.exit(1);
}
const fixedPort = arg('port') || process.env.CREW_PORT;
let port = fixedPort !== undefined ? Number(fixedPort) : 4780; // 0 = any free port

const server = createServer(tls);
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && !fixedPort && port < 4800) return server.listen(++port, host);
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
});
server.on('listening', () => {
  port = (server.address() as { port: number }).port;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const scheme = tls ? 'https' : 'http';
  console.log(`Crew runtime "${db.config.name}" (${VERSION}) — data in ${HOME}`);
  console.log(`Listening on ${scheme}://${host}:${port}`);
  // The token is in the #fragment, which browsers never send to the server or put in logs.
  console.log(`Open:  ${scheme}://${shown}:${port}/#token=${db.config.token}`);
  if (!loopback && !tls) console.log('Note: plain HTTP on a non-loopback address (--allow-insecure-http). Make sure TLS terminates in front of it.');
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
