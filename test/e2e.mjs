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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockServer } from './mock-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'dist', 'cli.js');

// Keep the cache off the developer's real ~/.grokscope for the whole run.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'grokscope-e2e-'));

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
  // Default cache home for every spawned CLI; individual tests may override it.
  env.GROKSCOPE_HOME = path.join(TMP_HOME, 'home-main');
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
    r.stderr.includes('Get a key at https://console.x.ai') && r.stderr.includes('add credits'),
    r.stderr.slice(0, 200),
  );
  // xAI grants no automatic credit (confirmed live 2026-07-16) — never promise any.
  check(
    'missing key -> promises no free credit',
    !/free credit|\$20|includes .* credit/i.test(r.stderr),
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
  const r = await runCli(['ask', 'bun vs node', '--fresh'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${flakyPort}/v1`,
  });
  check('retry -> survives a 429 and succeeds', r.code === 0 && r.stdout.includes('Community Verdict'), r.stderr.slice(0, 300));
  check('retry -> exactly one retry made', flaky.requests.length === 2 && flaky.requests[0].rateLimited === true, JSON.stringify(flaky.requests.length));
  await flaky.close();
}

// 12. demo mode — replays recorded samples with NO API key or network
{
  const fixtures = path.join(root, 'test', 'fixtures');
  const demoEnv = { GROKSCOPE_DEMO_DIR: fixtures };

  const dr = await runCli(['demo'], demoEnv);
  check('demo -> runs with no API key, exit 0', dr.code === 0, dr.stderr.slice(0, 200));
  check(
    'demo -> renders cited content + Sources',
    /https:\/\/x\.com\/\w+\/status\/\d+/.test(dr.stdout) && /SOURCES|Sources/.test(dr.stdout),
    dr.stdout.slice(-300),
  );
  check(
    'demo -> banner marks it a recorded sample (stderr)',
    /recorded sample/i.test(dr.stderr) && /no API key/i.test(dr.stderr),
    dr.stderr.slice(0, 200),
  );

  const dj = await runCli(['demo', 'ask', '--json'], demoEnv);
  let parsed = null;
  try { parsed = JSON.parse(dj.stdout); } catch {}
  check(
    'demo --json -> valid JSON with content',
    dj.code === 0 && parsed && typeof parsed.content === 'string' && parsed.command === 'ask',
    dj.stdout.slice(0, 150),
  );

  const dc = await runCli(['demo', 'compare'], demoEnv);
  check('demo compare -> exit 0 with cited sources', dc.code === 0 && /https:\/\/x\.com\//.test(dc.stdout), dc.stderr.slice(0, 200));

  const dall = await runCli(['demo', '--all'], demoEnv);
  check(
    'demo --all -> renders all three samples',
    dall.code === 0 && (dall.stderr.match(/recorded sample/gi) ?? []).length === 3,
    String((dall.stderr.match(/recorded sample/gi) ?? []).length),
  );

  const dbad = await runCli(['demo', 'nonsense'], demoEnv);
  check('demo unknown -> exit 1 with guidance', dbad.code === 1 && /Unknown demo/.test(dbad.stderr), dbad.stderr.slice(0, 150));
}

// 13. >20 handles -> client-side error, exit 1, NO API call (finding #4)
{
  const hmock = createMockServer();
  const hport = await hmock.listen();
  const many = Array.from({ length: 21 }, (_, i) => `h${i}`).join(',');
  const r = await runCli(['ask', 'too many handles', '--handles', many], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${hport}/v1`,
  });
  check('handles cap -> exit 1 with flag-named error', r.code === 1 && /--handles accepts at most 20 handles \(got 21\)/.test(r.stderr), r.stderr.slice(0, 200));
  check('handles cap -> rejected before any API call', hmock.requests.length === 0, `requests=${hmock.requests.length}`);
  await hmock.close();
}

// 14. --handles + --exclude -> flag-named conflict, before the key check (finding #9)
{
  const r = await runCli(['ask', 'conflict probe', '--handles', 'a', '--exclude', 'b'], {});
  check('handles/exclude conflict -> flag-named error, exit 1', r.code === 1 && /--handles and --exclude can't be combined\./.test(r.stderr), r.stderr.slice(0, 200));
  check('handles/exclude conflict -> checked before the API key', !/Get a key at https:\/\/console\.x\.ai/.test(r.stderr), r.stderr.slice(0, 200));
}

// 15. 5xx with NO Retry-After header -> backoff runs, retry succeeds (finding #2)
{
  const s = createMockServer({ failFirst: 1, failFirstStatus: 503, failFirstNoRetryAfter: true });
  const sport = await s.listen();
  const r = await runCli(['ask', 'server error probe', '--fresh'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${sport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'srv-home'),
  });
  check('5xx no Retry-After -> retries and succeeds', r.code === 0 && r.stdout.includes('Community Verdict'), r.stderr.slice(0, 200));
  check('5xx no Retry-After -> exactly one retry (2 requests)', s.requests.length === 2 && s.requests[0].status === 503, JSON.stringify(s.requests.map((x) => x.status)));
  await s.close();
}

// 16. 402 out of credits -> friendly top-up message (finding surfaced via grok.ts)
{
  const p = createMockServer({ respondStatus: 402, errorMessage: 'Your team has no credits remaining' });
  const pport = await p.listen();
  const r = await runCli(['ask', 'credits probe', '--fresh'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${pport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'credits-home'),
  });
  check('402 -> out-of-credits message, exit 1', r.code === 1 && /out of credits/i.test(r.stderr) && /console\.x\.ai/.test(r.stderr), r.stderr.slice(0, 200));
  await p.close();
}

// 17. non-JSON 200 -> friendly unreadable-response error (finding #6)
{
  const nj = createMockServer({ respondNonJson: true });
  const njport = await nj.listen();
  const r = await runCli(['ask', 'nonjson probe', '--fresh'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${njport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'nonjson-home'),
  });
  check('non-JSON 200 -> unreadable-response error, exit 1', r.code === 1 && /unreadable \(non-JSON\) response/i.test(r.stderr), r.stderr.slice(0, 200));
  await nj.close();
}

// 18. status: incomplete with partial content -> render + truncation warning (finding #7)
{
  const inc = createMockServer({ respondIncomplete: true });
  const incport = await inc.listen();
  const r = await runCli(['ask', 'incomplete probe', '--fresh'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${incport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'inc-home'),
  });
  check('incomplete -> still renders partial content, exit 0', r.code === 0 && r.stdout.includes('Community Verdict'), r.stdout.slice(-200));
  check('incomplete -> warns the response was truncated', /truncated/i.test(r.stderr), r.stderr.slice(0, 200));
  await inc.close();
}

// 19. inline citation renumbering: out-of-order [[3]]/[[1]] match the Sources order (finding #3)
{
  const rm = createMockServer({ outOfOrderCitations: true });
  const rport = await rm.listen();
  const r = await runCli(['ask', 'renumber probe', '--fresh'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${rport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'renum-home'),
  });
  check('renumber -> exit 0', r.code === 0, r.stderr.slice(0, 200));
  check(
    'renumber -> first-cited source is [1], not the model literal [3]',
    /\[1\]\s*\(https:\/\/x\.com\/firstsource\//.test(r.stdout) && !/\[3\]\s*\(https:\/\/x\.com\/firstsource\//.test(r.stdout),
    r.stdout,
  );
  check('renumber -> second source is [2] (was model literal 1)', /\[2\]\s*\(https:\/\/x\.com\/secondsource\//.test(r.stdout), r.stdout);
  check(
    'renumber -> Sources numbered by first appearance',
    /1\.\s*https:\/\/x\.com\/firstsource\//.test(r.stdout) && /2\.\s*https:\/\/x\.com\/secondsource\//.test(r.stdout),
    r.stdout.slice(-300),
  );
  await rm.close();
}

// 20. caching: identical repeat is free; --fresh forces a call; history lists + re-prints (feature C)
{
  const cmock = createMockServer();
  const cport = await cmock.listen();
  const cenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${cport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'cache-home'),
  };

  const first = await runCli(['ask', 'cache probe alpha'], cenv);
  check('cache -> first call succeeds', first.code === 0, first.stderr.slice(0, 200));
  check('cache -> first call makes one API hit', cmock.requests.length === 1, `requests=${cmock.requests.length}`);

  const second = await runCli(['ask', 'cache probe alpha'], cenv);
  check('cache -> identical repeat makes 0 new API hits', second.code === 0 && cmock.requests.length === 1, `code=${second.code} requests=${cmock.requests.length}`);
  check('cache -> repeat notes (from cache)', /from cache/i.test(second.stderr), second.stderr.slice(0, 200));
  check('cache -> repeat still renders the result', second.stdout.includes('Community Verdict'), second.stdout.slice(-200));

  const fresh = await runCli(['ask', 'cache probe alpha', '--fresh'], cenv);
  check('cache -> --fresh forces a real API call', fresh.code === 0 && cmock.requests.length === 2, `requests=${cmock.requests.length}`);

  const listOut = await runCli(['history'], cenv);
  check('history -> lists the cached entry', listOut.code === 0 && /cache probe alpha/.test(listOut.stdout), listOut.stdout.slice(0, 300));

  const hitsBefore = cmock.requests.length;
  const show = await runCli(['history', '1'], cenv);
  check(
    'history <n> -> re-prints for free (0 new API hits)',
    show.code === 0 && cmock.requests.length === hitsBefore && show.stdout.includes('Community Verdict'),
    `code=${show.code} requests=${cmock.requests.length}`,
  );
  await cmock.close();
}

// 21. release — reaction report with a 14-day default window
{
  const rmock = createMockServer();
  const rport = await rmock.listen();
  const renv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${rport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'release-home'),
  };
  const r = await runCli(['release', 'nextjs', '15'], renv);
  check('release -> exit 0', r.code === 0, r.stderr.slice(0, 300));
  check('release -> Upgrade Verdict section', r.stdout.includes('Upgrade Verdict'), r.stdout.slice(-300));
  check('release -> separates praise from problems', /Praise/.test(r.stdout) && /Problems/.test(r.stdout), r.stdout.slice(0, 400));
  check('release -> sources cited', (r.stdout.match(/https:\/\/x\.com\//g) ?? []).length >= 4, r.stdout.slice(-400));
  check(
    'release -> 14-day window',
    rmock.requests.at(-1).tools[0].from_date === new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10),
    JSON.stringify(rmock.requests.at(-1).tools),
  );
  check('release -> version reaches the prompt', /nextjs 15/.test(rmock.requests.at(-1).input[0].content), rmock.requests.at(-1).input[0].content);

  const latest = await runCli(['release', 'bun'], renv);
  check('release -> no version asks about the latest release', latest.code === 0 && /the latest bun release/.test(rmock.requests.at(-1).input[0].content), rmock.requests.at(-1).input[0].content);
  await rmock.close();
}

// 22. pain — ranked pain-point digest with a 30-day default window
{
  const pmock = createMockServer();
  const pport = await pmock.listen();
  const penv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${pport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'pain-home'),
  };
  const r = await runCli(['pain', 'webpack'], penv);
  check('pain -> exit 0', r.code === 0, r.stderr.slice(0, 300));
  check('pain -> ranked numbered list', /1\.\s/.test(r.stdout) && /2\.\s/.test(r.stdout), r.stdout.slice(0, 400));
  check('pain -> Biggest Pain verdict line', r.stdout.includes('Biggest Pain'), r.stdout.slice(-300));
  check('pain -> mentions a workaround', /workaround/i.test(r.stdout), r.stdout.slice(0, 400));
  check(
    'pain -> 30-day window',
    pmock.requests.at(-1).tools[0].from_date === new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
    JSON.stringify(pmock.requests.at(-1).tools),
  );
  await pmock.close();
}

// 23. watch — topic list lifecycle, snapshots, deltas, log
{
  const wmock = createMockServer();
  const wport = await wmock.listen();
  const whome = path.join(TMP_HOME, 'watch-home');
  const wenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${wport}/v1`,
    GROKSCOPE_HOME: whome,
  };

  const empty = await runCli(['watch'], wenv);
  check('watch (empty) -> guidance, exit 0', empty.code === 0 && /No watched topics yet/.test(empty.stdout), empty.stdout);
  const runEmpty = await runCli(['watch', 'run'], wenv);
  check('watch run (empty) -> exit 1 before any API call', runEmpty.code === 1 && /No watched topics yet/.test(runEmpty.stderr) && wmock.requests.length === 0, runEmpty.stderr);

  const add = await runCli(['watch', 'add', 'rust', 'typescript'], wenv);
  check('watch add -> confirms both topics', add.code === 0 && /Watching 2 topics: rust, typescript/.test(add.stdout), add.stdout);
  const dup = await runCli(['watch', 'add', 'RUST'], wenv);
  check('watch add -> dedupes case-insensitively', dup.code === 0 && /Watching 2 topics/.test(dup.stdout), dup.stdout);
  const listed = await runCli(['watch', 'list'], wenv);
  check('watch list -> shows the topics', /1\. rust/.test(listed.stdout) && /2\. typescript/.test(listed.stdout), listed.stdout);

  // Seed an older snapshot so the next run has something to diff against:
  // rust was negative/stable, typescript was mixed/stable.
  const seeded = {
    at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    days: 7,
    model: 'grok-4.5',
    readings: [
      { topic: 'rust', sentiment: 'negative', momentum: 'stable' },
      { topic: 'typescript', sentiment: 'mixed', momentum: 'stable' },
    ],
  };
  mkdirSync(whome, { recursive: true });
  writeFileSync(path.join(whome, 'watch-history.jsonl'), `${JSON.stringify(seeded)}\n`);

  // The mock reports rust positive/rising, typescript mixed/stable.
  const run1 = await runCli(['watch', 'run'], wenv);
  check('watch run -> exit 0 with the report', run1.code === 0 && /buzz report/i.test(run1.stdout), run1.stderr.slice(0, 300));
  check('watch run -> sends a trending-shaped query', /trend analyst/.test(wmock.requests.at(-1).instructions), wmock.requests.at(-1).instructions);
  check('watch run -> shows what moved since last snapshot', /Changes since/.test(run1.stdout) && /sentiment negative -> positive/.test(run1.stdout) && /momentum stable -> rising/.test(run1.stdout), run1.stdout.slice(-500));
  check('watch run -> unchanged topic says so', /typescript\s+no change \(mixed, stable\)/.test(run1.stdout), run1.stdout.slice(-500));
  const histLines = readFileSync(path.join(whome, 'watch-history.jsonl'), 'utf8').trim().split('\n');
  check('watch run -> appends a snapshot', histLines.length === 2, `lines=${histLines.length}`);

  const log = await runCli(['watch', 'log'], wenv);
  check('watch log -> one dated row per snapshot', log.code === 0 && (log.stdout.match(/^\s+\d{4}-\d{2}-\d{2}\s/gm) ?? []).length === 2, log.stdout);
  const logTopic = await runCli(['watch', 'log', 'rust'], wenv);
  check('watch log <topic> -> filters to that topic', /rust: /.test(logTopic.stdout) && !/typescript: /.test(logTopic.stdout), logTopic.stdout);

  const rm = await runCli(['watch', 'rm', 'rust'], wenv);
  check('watch rm -> removes the topic', rm.code === 0 && /Watching: typescript/.test(rm.stdout), rm.stdout);
  const rmMissing = await runCli(['watch', 'rm', 'rust'], wenv);
  check('watch rm -> unknown topic errors', rmMissing.code === 1 && /not on the watch list/.test(rmMissing.stderr), rmMissing.stderr);

  const runJson = await runCli(['watch', 'run', '--json'], wenv);
  let wparsed = null;
  try { wparsed = JSON.parse(runJson.stdout); } catch {}
  check('watch run --json -> valid JSON with watch block', runJson.code === 0 && wparsed?.command === 'watch' && Array.isArray(wparsed?.watch?.topics), runJson.stdout.slice(0, 200));
  check(
    'watch run --json -> delta fields per topic',
    wparsed?.watch?.topics?.[0]?.topic === 'typescript' && wparsed.watch.topics[0].sentiment === 'positive' && wparsed.watch.topics[0].prevSentiment === 'mixed' && wparsed.watch.topics[0].changed === true && typeof wparsed.watch.previousSnapshotAt === 'string',
    JSON.stringify(wparsed?.watch),
  );
  await wmock.close();

  // First-ever snapshot (fresh home): no delta yet, but say so.
  const fmock = createMockServer();
  const fport = await fmock.listen();
  const fenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${fport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'watch-home-first'),
  };
  await runCli(['watch', 'add', 'zig'], fenv);
  const first = await runCli(['watch', 'run'], fenv);
  check('watch run (first) -> notes the first snapshot on stderr', first.code === 0 && /First snapshot recorded/.test(first.stderr) && !/Changes since/.test(first.stdout), first.stderr.slice(0, 300));
  await fmock.close();
}

// 24. cache command — stats + clear
{
  const cm = createMockServer();
  const cp = await cm.listen();
  const cenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${cp}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'cachecmd-home'),
  };
  await runCli(['ask', 'cache stats probe'], cenv);
  const st = await runCli(['cache'], cenv);
  check('cache -> stats show the entry + size', st.code === 0 && /Entries: 1/.test(st.stdout) && /Size: /.test(st.stdout), st.stdout);
  const keep = await runCli(['cache', 'clear', '--older-than', '48'], cenv);
  check('cache clear --older-than -> keeps fresh entries', keep.code === 0 && /Nothing to clear/.test(keep.stdout), keep.stdout);
  const cl = await runCli(['cache', 'clear'], cenv);
  check('cache clear -> removes the entry', cl.code === 0 && /Removed 1 cached result/.test(cl.stdout), cl.stdout);
  const st2 = await runCli(['cache'], cenv);
  check('cache -> empty after clear', /Entries: 0/.test(st2.stdout), st2.stdout);
  const h = await runCli(['history'], cenv);
  check('history -> empty after cache clear', /No cached results yet/.test(h.stdout), h.stdout);
  await cm.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
