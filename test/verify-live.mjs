/**
 * LIVE acceptance test — runs the brief's three acceptance commands against
 * the REAL xAI API. Requires GROK_API_KEY (or XAI_API_KEY) in the env.
 *
 *   npm run verify:live
 *
 * Expected total cost: a few cents (3 queries at grok-4.5 rates).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'dist', 'cli.js');

if (!process.env.GROK_API_KEY && !process.env.XAI_API_KEY) {
  console.error('Set GROK_API_KEY first (get one at https://console.x.ai), then re-run.');
  process.exit(1);
}
if (process.env.GROK_BASE_URL) {
  console.error(`Note: GROK_BASE_URL is set (${process.env.GROK_BASE_URL}) — this will NOT hit the real API. Unset it for live verification.`);
  process.exit(1);
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n      ${detail.slice(0, 400)}`}`);
}

const X_POST = /https:\/\/(?:x|twitter)\.com\/[^/\s)]+\/status\/\d+/;

console.log('0/3  grokscope doctor  (free — validates key before spending)...');
{
  const r = await runCli(['doctor']);
  check('doctor -> setup healthy', r.code === 0, r.stdout);
  if (r.code !== 0) {
    console.log(r.stdout);
    console.log('\nFix the setup first, then re-run. No tokens were spent.');
    process.exit(1);
  }
}

console.log('1/3  grokscope ask "bun vs node in 2026"  (30-day window, ~1-3 min)...');
{
  const r = await runCli(['ask', 'bun vs node in 2026']);
  check('ask -> exit 0', r.code === 0, r.stderr);
  check('ask -> at least one cited X post URL', X_POST.test(r.stdout), r.stdout);
  check('ask -> Community Verdict section', /community verdict/i.test(r.stdout), r.stdout.slice(-600));
  console.log(`      ${r.stderr.trim().split('\n').at(-1) ?? ''}`); // cost line
}

console.log('2/3  grokscope compare react solidjs ...');
{
  const r = await runCli(['compare', 'react', 'solidjs']);
  check('compare -> exit 0', r.code === 0, r.stderr);
  check('compare -> mentions both techs', /react/i.test(r.stdout) && /solid/i.test(r.stdout));
  check('compare -> has cited sources', X_POST.test(r.stdout) || /https?:\/\//.test(r.stdout), r.stdout.slice(-600));
  console.log(`      ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
}

console.log('3/3  grokscope trending --topics "rust,typescript,go" ...');
{
  const r = await runCli(['trending', '--topics', 'rust,typescript,go']);
  check('trending -> exit 0', r.code === 0, r.stderr);
  check(
    'trending -> covers all three topics',
    ['rust', 'typescript', 'go'].every((t) => new RegExp(t, 'i').test(r.stdout)),
    r.stdout.slice(0, 600),
  );
  console.log(`      ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
if (!failed) console.log('LIVE VERIFICATION COMPLETE — ready to ship. Next: SHIP.md');
process.exit(failed ? 1 : 0);
