/**
 * End-to-end test: runs the built CLI (dist/cli.js) as a child process
 * against the doc-accurate mock of xAI's /v1/responses.
 *
 * Covers the brief's acceptance criteria:
 *  1. missing GROK_API_KEY -> exact help message, exit 1
 *  2. ask   -> cited X post URL + Community Verdict section
 *  3. compare -> both technologies + sources for each side
 *  4. trending -> one paragraph per topic
 *  plus wire-schema validation (mock 400s on any non-spec request).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMockServer } from './mock-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'dist', 'cli.js');

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...cleanEnv(), ...env },
      cwd: root,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.GROK_API_KEY;
  delete env.XAI_API_KEY;
  delete env.GROK_BASE_URL;
  delete env.GROK_MODEL;
  return env;
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
}

const mock = createMockServer();
const port = await mock.listen();
const env = { GROK_API_KEY: 'xai-test-key', GROK_BASE_URL: `http://127.0.0.1:${port}/v1` };

// 1. Missing key
{
  const r = await runCli(['ask', 'bun vs node in 2026'], {});
  check('missing key -> exit 1', r.code === 1, `exit=${r.code}`);
  check(
    'missing key -> console.x.ai message',
    r.stderr.includes('Get your free key (includes $20 credit) at https://console.x.ai'),
    r.stderr.slice(0, 200),
  );
}

// 2. ask
{
  const r = await runCli(['ask', 'bun', 'vs', 'node', 'in', '2026'], env);
  check('ask -> exit 0', r.code === 0, r.stderr.slice(0, 300));
  check('ask -> cites an X post URL', /https:\/\/x\.com\/\w+\/status\/\d+/.test(r.stdout), r.stdout.slice(0, 300));
  check('ask -> Community Verdict section', r.stdout.includes('Community Verdict'));
  check('ask -> Sources section with recency tags', /SOURCES|Sources/.test(r.stdout) && /\(\d+d ago\)|\(today\)/.test(r.stdout), r.stdout.slice(-400));
  const req = mock.requests.at(-1);
  check('ask -> sends x_search tool with 30-day from_date', req.tools[0].type === 'x_search' && req.tools[0].from_date === new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), JSON.stringify(req.tools));
}

// 3. compare
{
  const r = await runCli(['compare', 'react', 'solidjs'], env);
  check('compare -> exit 0', r.code === 0, r.stderr.slice(0, 300));
  check('compare -> mentions both techs', r.stdout.includes('react') && r.stdout.includes('solidjs'));
  check('compare -> pros/cons for each side', /react — pros/i.test(r.stdout) && /solidjs — pros/i.test(r.stdout));
  check('compare -> sources cited', (r.stdout.match(/https:\/\/x\.com\//g) ?? []).length >= 4, r.stdout.slice(-400));
  check('compare -> 7-day window', mock.requests.at(-1).tools[0].from_date === new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
}

// 4. trending
{
  const r = await runCli(['trending', '--topics', 'rust,typescript,go'], env);
  check('trending -> exit 0', r.code === 0, r.stderr.slice(0, 300));
  check(
    'trending -> one paragraph per topic',
    ['rust', 'typescript', 'go'].every((t) => new RegExp(`${t}.*sentiment`, 'i').test(r.stdout)),
    r.stdout.slice(0, 500),
  );
  check('trending -> momentum reported', /Momentum: (rising|falling|stable)/.test(r.stdout));
}

// 5. handles filter goes over the wire correctly
{
  const r = await runCli(['ask', 'zig allocators', '--handles', '@ziglang, andrewrk', '--days', '14'], env);
  const req = mock.requests.at(-1);
  check('options -> allowed_x_handles stripped of @', r.code === 0 && JSON.stringify(req.tools[0].allowed_x_handles) === '["ziglang","andrewrk"]', JSON.stringify(req.tools?.[0]));
  check('options -> --days rewrites the prompt window', req.instructions.includes('last 14 days'), req.instructions);
}

// 6. --json mode
{
  const r = await runCli(['ask', 'bun vs node', '--json'], env);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  check('json -> valid JSON on stdout', r.code === 0 && parsed !== null, r.stdout.slice(0, 200));
  check('json -> schema fields present', parsed && parsed.tool === 'grokscope' && parsed.command === 'ask' && parsed.searchWindowDays === 30 && typeof parsed.content === 'string');
  check('json -> citations with postedAt + recency', parsed && parsed.citations.length >= 3 && parsed.citations.every((c) => /^https:\/\/x\.com\//.test(c.url)) && parsed.citations[0].postedAt && parsed.citations[0].recency, JSON.stringify(parsed?.citations?.[0]));
  check('json -> usage with estimated cost', parsed && parsed.usage.estimatedCostUsd > 0, JSON.stringify(parsed?.usage));
}

// 7. --md mode
{
  const r = await runCli(['compare', 'react', 'solidjs', '--md'], env);
  check('md -> raw markdown preserved', r.code === 0 && r.stdout.includes('**') && r.stdout.includes('## '), r.stdout.slice(0, 200));
  check('md -> Sources section with ISO dates', /## Sources/.test(r.stdout) && /\d{4}-\d{2}-\d{2} \(\d+d ago\)/.test(r.stdout), r.stdout.slice(-300));
}

// 8. --json + --md rejected
{
  const r = await runCli(['ask', 'x', '--json', '--md'], env);
  check('json+md -> mutually exclusive error', r.code === 1 && /mutually exclusive/.test(r.stderr), r.stderr);
}

// 9. doctor
{
  const r = await runCli(['doctor'], env);
  check('doctor -> healthy setup exits 0', r.code === 0, r.stdout + r.stderr);
  check('doctor -> validates key + model', /PASS {2}key valid: yes/.test(r.stdout) && /PASS {2}model grok-4.5: available/.test(r.stdout), r.stdout);
  const bad = await runCli(['doctor'], { ...env, GROK_API_KEY: 'bad-key' });
  check('doctor -> invalid key exits 1 with FAIL', bad.code === 1 && /FAIL {2}key valid: no/.test(bad.stdout), bad.stdout);
  const noKey = await runCli(['doctor'], {});
  check('doctor -> missing key guides to console.x.ai', noKey.code === 1 && noKey.stdout.includes('https://console.x.ai'), noKey.stdout);
}

// 9b. a 403 is a permission/credit problem, NOT a wrong key — doctor must say so
// and must surface the API's own message rather than swallowing it.
{
  const f = await runCli(['doctor'], { ...env, GROK_API_KEY: 'forbidden-key' });
  check('doctor -> 403 is not reported as an invalid key', f.code === 1 && !/key valid: no/.test(f.stdout), f.stdout);
  check('doctor -> 403 names the permission cause', /HTTP 403/.test(f.stdout) && /may not make the call/.test(f.stdout), f.stdout);
  check('doctor -> 403 surfaces the API message', /does not have any credits remaining/.test(f.stdout), f.stdout);
  check('doctor -> 403 points at key ACL + billing', /API Keys/.test(f.stdout) && /Billing/.test(f.stdout), f.stdout);
}

// 10. bad key on a query surfaces a helpful auth error
{
  const r = await runCli(['ask', 'anything'], { ...env, GROK_API_KEY: 'bad-key' });
  check('query with bad key -> auth error message', r.code === 1 && /Authentication failed/.test(r.stderr) && r.stderr.includes('console.x.ai'), r.stderr);
}

// 10b. a 403 on a query explains itself instead of blaming the key
{
  const r = await runCli(['ask', 'anything'], { ...env, GROK_API_KEY: 'forbidden-key' });
  check('query with forbidden key -> not blamed on the key', r.code === 1 && !/Authentication failed/.test(r.stderr), r.stderr);
  check('query with forbidden key -> explains 403 + API message', /403/.test(r.stderr) && /does not have any credits remaining/.test(r.stderr), r.stderr);
}

await mock.close();

// 11. retry: first POST 429s, client retries and succeeds
{
  const flaky = createMockServer({ failFirst: 1 });
  const flakyPort = await flaky.listen();
  const r = await runCli(['ask', 'bun vs node'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${flakyPort}/v1`,
  });
  check('retry -> survives a 429 and succeeds', r.code === 0 && r.stdout.includes('Community Verdict'), r.stderr.slice(0, 300));
  check('retry -> exactly one retry made', flaky.requests.length === 2 && flaky.requests[0].rateLimited === true, JSON.stringify(flaky.requests.length));
  await flaky.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
