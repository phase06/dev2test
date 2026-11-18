// Launches the Electron shell and checks the window shows the local runtime's UI.
//   xvfb-run -a node test/desktop-smoke.cjs      (xvfb only needed on headless Linux)
const { _electron } = require('playwright');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-desktop-'));
  const app = await _electron.launch({ executablePath: require(path.join(__dirname, '..', 'node_modules', 'electron')), args: ['.', '--no-sandbox'], cwd: path.join(__dirname, '..'), env: { ...process.env, CREW_HOME: home } });
  try {
    const win = await app.firstWindow();
    await win.getByText('Connect a model').waitFor({ timeout: 20000 });
    const url = win.url();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('Unexpected window URL ' + url);
    if (!fs.existsSync(path.join(home, 'config.json'))) throw new Error('Runtime did not use CREW_HOME');
    console.log('Desktop smoke test passed:', url);
  } finally {
    await app.close().catch(() => {});
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
