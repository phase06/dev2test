// Drives the real UI in a browser against two runtimes ("local" + "remote VM") and a mock provider.
//   npm run build && node test/ui-smoke.mjs [screenshot-dir]
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-provider.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'crew-shots-'));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ui-'));
const kids = [];
const startRuntime = (name) =>
  new Promise((resolve) => {
    const c = fork(new URL('../dist/crew-runtime.mjs', import.meta.url), ['--port', '0', '--name', name], { env: { ...process.env, CREW_HOME: path.join(tmp, name) }, silent: true });
    kids.push(c);
    c.on('message', (m) => m.ready && resolve({ url: `http://127.0.0.1:${m.port}`, token: m.token }));
  });

const mock = await startMock();
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
const local = await startRuntime('my-laptop');
const remote = await startRuntime('build-vm');
const browser = await chromium.launch();
const errors = [];
let step = 0;
let page;
const shot = async (name) => page.screenshot({ path: path.join(out, `${String(++step).padStart(2, '0')}-${name}.png`) });

async function addProvider() {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Add provider' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('select').first().selectOption({ label: 'Custom OpenAI-compatible' });
  await dlg.getByLabel('Name').fill('Company gateway');
  await dlg.getByLabel('Base URL').fill(mockUrl);
  await dlg.getByLabel('API key').fill('sk-test');
  await page.getByRole('button', { name: 'Fetch models' }).click();
  await page.getByText('Found 2 models.').waitFor();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByText(/mock-large replied/).waitFor();
}
async function addBot(role, policy) {
  await page.getByRole('button', { name: 'Add teammate' }).first().click();
  await page.getByRole('button', { name: role }).click();
  if (policy) await page.getByText(policy, { exact: true }).click();
  await page.getByText('Host', { exact: true }).click(); // keep the smoke test independent of Docker
  if (role === 'Reviewer') await shot('teammate-profile');
  await page.getByRole('button', { name: 'Add teammate' }).last().click();
  await page.getByPlaceholder(/^Message /).waitFor();
}
const send = async (text) => {
  await page.getByPlaceholder(/^Message/).fill(text);
  await page.keyboard.press('Enter');
};

try {
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/401|Failed to load resource/.test(m.text()) && errors.push(m.text()));

  await page.goto(`${local.url}/#token=${local.token}`);
  await page.getByText('Connect a model').waitFor();
  await shot('onboarding');

  await addProvider();
  await shot('provider');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Company gateway').waitFor();

  // Ada asks first; approve her shell command.
  await addBot('Software engineer');
  await send('run the build');
  await page.getByRole('button', { name: 'Approve' }).waitFor();
  await shot('approval');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText(/hello-from-Ada/).first().waitFor();

  await addBot('Reviewer', 'Autonomous');
  // Delegation from a DM.
  await page.getByRole('button', { name: /^A Ada/ }).click();
  await send('delegate this to Rex');
  await page.getByText('Ask Rex').waitFor();
  await page.getByText(/Done\. Result:\s*It is 4\./).waitFor();

  // Group chat with an @mention handoff.
  await page.getByRole('button', { name: 'New group chat' }).click();
  await page.getByLabel('Topic').fill('Q3 launch');
  await page.getByRole('dialog').getByText('Ada').click();
  await page.getByRole('dialog').getByText('Rex').click();
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByPlaceholder(/^Message the team/).waitFor();
  await send('Team, time for a handoff on the launch plan');
  await page.getByText(/looks good/).waitFor();
  await shot('group-chat');

  // Team memory.
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.locator('.team-memory textarea').fill('- We ship on Fridays.\n- The CTO is Sam.');
  await page.getByRole('button', { name: 'Save team memory' }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  await shot('team-memory');
  await page.getByRole('button', { name: /^A Ada/ }).click();
  await send('what do you recall?');
  await page.getByText(/We ship on Fridays/).waitFor();

  // Routine.
  await page.getByRole('button', { name: 'Routines' }).click();
  await page.getByRole('button', { name: 'New routine' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Morning digest');
  await page.getByRole('dialog').getByLabel('Instructions').fill('Say hello and summarise overnight changes.');
  await page.getByRole('dialog').locator('select').last().selectOption({ label: 'Weekdays at 09:00' });
  await page.getByRole('button', { name: 'Save routine' }).click();
  await page.getByText(/Weekdays at 09:00/).waitFor();
  await shot('routines');
  await page.getByRole('button', { name: 'Run now' }).click();
  await page.getByText(/Hello from Ada/).waitFor();

  // Connect the "remote VM", switch to it, set it up, and copy a teammate across.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect remote' }).click();
  await page.getByLabel(/Runtime URL/).fill(`${remote.url}/#token=${remote.token}`);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.list').getByText('build-vm').waitFor();
  await page.locator('.rt-current').click();
  await shot('runtime-switcher');
  await page.locator('.rt-menu').getByText('build-vm').click();
  await page.getByText('Your team on build-vm').waitFor();
  await addProvider();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rt-current').click();
  await page.locator('.rt-menu').getByText('my-laptop').click();
  await page.getByRole('button', { name: 'Edit Ada' }).click({ force: true });
  await page.locator('select.btn').selectOption({ label: 'build-vm' });
  await page.getByText(/Copied to build-vm/).waitFor();
  await page.locator('.rt-current').click();
  await page.locator('.rt-menu').getByText('build-vm').click();
  await page.getByRole('button', { name: /^A Ada/ }).click();
  await send('run the build');
  await page.getByText(/hello-from-Ada/).first().waitFor(); // copied bots are autonomous: no approval on the VM
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await shot('remote-team');

  // Reload: the remote connection is remembered by the home runtime, not the browser.
  await page.reload();
  await page.getByText('Your team on build-vm').waitFor();

  // Phone width must not scroll sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 0) errors.push(`Horizontal overflow at 390px: ${overflow}px`);

  if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
  console.log(`UI smoke test passed. Screenshots: ${out}`);
} catch (e) {
  await shot('FAILED').catch(() => {});
  console.error(e.message, `\nScreenshots: ${out}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  kids.forEach((k) => k.kill());
  mock.close();
}
