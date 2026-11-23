#!/usr/bin/env node
// Free sanity check of every case's grader, no model involved:
//   null:   the untouched fixtures (nothing done)        -> at least one check must FAIL
//   oracle: fixtures + the case's solution/ end state   -> every check must PASS
//   noise:  the oracle again                             -> same result (checks are deterministic)
// A case that fails this can't tell a good run from a bad one.
//   node eval/solo/validate-cases.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASES = resolve(dirname(fileURLToPath(import.meta.url)), 'cases');
const parse = (out) => out.split('\n').map((l) => /^(PASS|FAIL) ([^:]+?)(?::\s*(.*))?$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[2], pass: m[1] === 'PASS' }));

function check(dir, withSolution) {
  const ws = mkdtempSync(join(tmpdir(), 'crew-validate-'));
  try {
    if (existsSync(join(dir, 'files'))) cpSync(join(dir, 'files'), ws, { recursive: true });
    if (withSolution) cpSync(join(dir, 'solution'), ws, { recursive: true });
    let out = '';
    try {
      out = execFileSync('bash', [join(dir, 'check.sh')], { cwd: ws, env: { ...process.env, CASE_DIR: dir }, timeout: 120000 }).toString();
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return parse(out);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

let bad = 0;
const ids = readdirSync(CASES).filter((d) => existsSync(join(CASES, d, 'case.json'))).sort();
for (const id of ids) {
  const dir = join(CASES, id);
  const problems = [];
  if (!existsSync(join(dir, 'solution'))) problems.push('no solution/ directory');
  const nul = check(dir, false);
  const ora = existsSync(join(dir, 'solution')) ? check(dir, true) : [];
  const again = existsSync(join(dir, 'solution')) ? check(dir, true) : [];
  if (!nul.length) problems.push('check.sh printed no PASS/FAIL lines');
  if (nul.length && nul.every((c) => c.pass)) problems.push('null (fixtures only) passes every check');
  if (ora.some((c) => !c.pass)) problems.push(`oracle fails: ${ora.filter((c) => !c.pass).map((c) => c.name).join(', ')}`);
  if (ora.length !== nul.length) problems.push(`check count differs between runs (${nul.length} vs ${ora.length})`);
  if (JSON.stringify(ora) !== JSON.stringify(again)) problems.push('oracle result is not deterministic');
  const line = `${id.padEnd(28)} null ${nul.filter((c) => c.pass).length}/${nul.length} pass   oracle ${ora.filter((c) => c.pass).length}/${ora.length} pass`;
  console.log(problems.length ? `✗ ${line}\n    ${problems.join('\n    ')}` : `✓ ${line}`);
  bad += problems.length ? 1 : 0;
}
console.log(`\n${ids.length - bad}/${ids.length} cases valid`);
process.exit(bad ? 1 : 0);
