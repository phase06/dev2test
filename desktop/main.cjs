// Electron shell: starts the bundled runtime as a child process (the "local" runtime), shows its UI,
// and stays in the tray so teammates and routines keep running when the window is closed.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, safeStorage } = require('electron');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const path = require('node:path');

const RUNTIME = path.join(__dirname, '..', 'dist', 'crew-runtime.mjs').replace('app.asar', 'app.asar.unpacked');
let runtime, win, tray, home, quitting = false;

/**
 * A key for encrypting provider API keys in the runtime's config.json, itself kept encrypted by the
 * OS keychain (macOS Keychain, Windows DPAPI, libsecret/kwallet on Linux). Returns null where no real
 * keychain is available (Linux falls back to a hard-coded password, which would protect nothing).
 */
function secretKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
    const f = path.join(app.getPath('userData'), 'runtime-key.bin');
    if (fs.existsSync(f)) return safeStorage.decryptString(fs.readFileSync(f));
    const key = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(f, safeStorage.encryptString(key), { mode: 0o600 });
    return key;
  } catch (e) {
    console.warn('Not encrypting API keys at rest:', e.message);
    return null;
  }
}

function startRuntime() {
  return new Promise((resolve, reject) => {
    const key = secretKey();
    runtime = fork(RUNTIME, ['--name', require('node:os').hostname()], {
      // Electron's own binary runs the runtime as plain Node, so users need no Node install.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CREW_HOME: process.env.CREW_HOME || path.join(app.getPath('userData'), 'runtime'),
        ...(key ? { CREW_SECRET_KEY: key } : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    runtime.once('message', (m) => m.ready && resolve(m));
    runtime.once('error', reject);
    runtime.once('exit', (code) => {
      reject(new Error(`Runtime exited with code ${code}`));
      if (!quitting) {
        dialog.showErrorBox('Crew', 'The local runtime stopped unexpectedly. Crew will quit.');
        app.quit();
      }
    });
  });
}

function showWindow() {
  if (win) return win.show(), win.focus();
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 720, minHeight: 520, title: 'Crew',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${home.port}/#token=${home.token}`);
  // The window only ever shows the local runtime's UI; everything else opens in the real browser.
  const external = (url) => !url.startsWith(`http://127.0.0.1:${home.port}/`);
  win.webContents.setWindowOpenHandler(({ url }) => (shell.openExternal(url), { action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => external(url) && (e.preventDefault(), shell.openExternal(url)));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // keep teammates running in the background
    win.hide();
  });
  win.on('closed', () => (win = null));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    try {
      home = await startRuntime();
    } catch (e) {
      dialog.showErrorBox('Crew could not start', String(e.message || e));
      return app.quit();
    }
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4AWP4z8DwnxLMMGoAw6gBDCPCAEYGBob/DAwM/xkYGBgZGBgYcCnAJkc1LzCMhgHDaBgwMAAA1bYYEWVJ1dIAAAAASUVORK5CYII=',
    );
    tray = new Tray(icon);
    tray.setToolTip('Crew — teammates are running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Crew', click: showWindow },
      { label: 'Open in browser', click: () => shell.openExternal(`http://127.0.0.1:${home.port}/#token=${home.token}`) },
      { type: 'separator' },
      { label: 'Quit (stops local teammates)', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
    showWindow();
  });
  app.on('activate', () => home && showWindow());
  app.on('window-all-closed', () => {}); // stay alive in the tray
  app.on('before-quit', () => {
    quitting = true;
    runtime?.kill();
  });
}
