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
  check(
    'json -> resolved costUsd + costExact flag present',
    parsed && typeof parsed.usage.costUsd === 'number' && typeof parsed.usage.costExact === 'boolean',
    JSON.stringify(parsed?.usage),
  );
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

// 25. exact billed cost (1.4.0): usage.cost_in_usd_ticks is xAI's actual billed
// amount (tokens + server-side tool spend, after cache discounts). The parser,
// the resolver, the JSON schema, the stderr line, and both replay paths must all
// prefer it — and fall back to the estimate when it is absent or malformed.
{
  // Unit-level: the 10^10 divisor must not silently rot (docs example: 158500
  // ticks = $0.00001585 — also why renderJson rounds to 8 decimals, not 6).
  const grok = await import(new URL('../dist/grok.js', import.meta.url).href);
  const fmt = await import(new URL('../dist/formatter.js', import.meta.url).href);
  const u = (usage) => grok.parseResponse({ usage }).usage;
  check(
    'ticks -> unit conversion: 158500 ticks = $0.00001585',
    grok.TICKS_PER_USD === 10_000_000_000 && u({ cost_in_usd_ticks: 158500 }).costUsd === 0.00001585,
    JSON.stringify(u({ cost_in_usd_ticks: 158500 })),
  );
  check('ticks -> zero is a real exact $0, not missing', u({ cost_in_usd_ticks: 0 }).costUsd === 0);
  check('ticks -> negative value never coerced', u({ cost_in_usd_ticks: -5 }).costUsd === undefined);
  check('ticks -> string value never coerced', u({ cost_in_usd_ticks: '158500' }).costUsdTicks === undefined);
  check('ticks -> null/absent leaves both undefined', u({ cost_in_usd_ticks: null }).costUsd === undefined && u({}).costUsdTicks === undefined);
  check(
    'resolveCost -> prefers exact, falls back to estimate',
    fmt.resolveCost({ costUsd: 0.1975, inputTokens: 68000, outputTokens: 2821 }, 'grok-4.5').usd === 0.1975 &&
      fmt.resolveCost({ costUsd: 0.1975 }, 'grok-4.5').exact === true &&
      fmt.resolveCost({ inputTokens: 68000, outputTokens: 2821 }, 'grok-4.5').exact === false &&
      fmt.resolveCost({ inputTokens: 68000, outputTokens: 2821 }, 'grok-4.5').usd === 0.152926,
  );

  // CLI-level, ticks present (mock default: 61,200,000 ticks = $0.00612 exact
  // vs a $0.00488 token estimate — the gap is the x_search tool spend).
  const em = createMockServer();
  const eport = await em.listen();
  const eenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${eport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'exact-home'),
  };
  const r = await runCli(['ask', 'exact cost probe', '--json'], eenv);
  let p = null;
  try { p = JSON.parse(r.stdout); } catch {}
  check('exact -> --json costUsd from ticks, costExact true', p?.usage.costUsd === 0.00612 && p?.usage.costExact === true, JSON.stringify(p?.usage));
  check('exact -> estimatedCostUsd keeps its old meaning and value', p?.usage.estimatedCostUsd === 0.00488, JSON.stringify(p?.usage));
  // The total carries no hedge; since 1.5.0 the X Search share after it does.
  check('exact -> stderr prints "$ billed", no tilde, no hedge', /\$0\.0061 billed/.test(r.stderr) && !/tokens · ~\$/.test(r.stderr) && !/estimated/.test(r.stderr), r.stderr);

  // Cache replay: the ticks travel with the raw body, so the hit prints the
  // identical exact line the live run did (acceptance #5, offline).
  const replay = await runCli(['ask', 'exact cost probe', '--json'], eenv);
  let p2 = null;
  try { p2 = JSON.parse(replay.stdout); } catch {}
  check(
    'exact -> cache replay prints the identical billed line, still exact',
    /from cache/.test(replay.stderr) && /\$0\.0061 billed/.test(replay.stderr) && p2?.usage.costUsd === 0.00612 && p2?.usage.costExact === true,
    replay.stderr,
  );
  const hist = await runCli(['history', '1', '--json'], eenv);
  let hp = null;
  try { hp = JSON.parse(hist.stdout); } catch {}
  check(
    'exact -> history <n> reports the same exact figure',
    hp?.usage.costUsd === 0.00612 && hp?.usage.costExact === true && /\$0\.0061 billed/.test(hist.stderr),
    `${JSON.stringify(hp?.usage)} ${hist.stderr}`,
  );
  await em.close();

  // Field absent (proxy / pre-ticks response / pre-1.4.0 cache entry).
  const om = createMockServer({ omitCostTicks: true });
  const oport = await om.listen();
  const oenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${oport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'omit-home'),
  };
  const or_ = await runCli(['ask', 'no ticks probe', '--json'], oenv);
  let op = null;
  try { op = JSON.parse(or_.stdout); } catch {}
  check(
    'no ticks -> costExact false, costUsd equals estimatedCostUsd',
    op?.usage.costExact === false && op?.usage.costUsd === op?.usage.estimatedCostUsd && op?.usage.costUsd === 0.00488,
    JSON.stringify(op?.usage),
  );
  check('no ticks -> stderr keeps the tilde + (estimated)', /~\$0\.0049 \(estimated\)/.test(or_.stderr) && !/billed/.test(or_.stderr), or_.stderr);
  const orep = await runCli(['ask', 'no ticks probe'], oenv);
  check(
    'no ticks -> cache replay of a ticks-less entry falls back cleanly',
    orep.code === 0 && /from cache/.test(orep.stderr) && /~\$0\.0049 \(estimated\)/.test(orep.stderr),
    orep.stderr,
  );
  await om.close();

  // Ticks present but GROK_MODEL unknown to the rate table: 1.3.0 printed no
  // dollar figure at all here — the exact field now populates costUsd anyway.
  const um = createMockServer({ expectModel: 'some-unreleased-model' });
  const uport = await um.listen();
  const uenv = {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${uport}/v1`,
    GROK_MODEL: 'some-unreleased-model',
    GROKSCOPE_HOME: path.join(TMP_HOME, 'unknown-model-home'),
  };
  const ur = await runCli(['ask', 'unknown model probe', '--json'], uenv);
  let up = null;
  try { up = JSON.parse(ur.stdout); } catch {}
  check(
    'unknown model + ticks -> numeric costUsd even with no estimatedCostUsd',
    up?.usage.costUsd === 0.00612 && up?.usage.costExact === true && !('estimatedCostUsd' in (up?.usage ?? {})),
    JSON.stringify(up?.usage),
  );
  check('unknown model + ticks -> dollar figure on stderr (1.3.0 printed none)', /\$0\.0061 billed/.test(ur.stderr), ur.stderr);
  await um.close();

  // cost_in_usd_ticks: 0 -> a real $0.0000, exact — not treated as missing.
  const zm = createMockServer({ costTicks: 0 });
  const zport = await zm.listen();
  const zr = await runCli(['ask', 'zero ticks probe', '--json'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${zport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'zero-home'),
  });
  let zp = null;
  try { zp = JSON.parse(zr.stdout); } catch {}
  check('zero ticks -> $0.0000 billed, exact', zp?.usage.costUsd === 0 && zp?.usage.costExact === true && /\$0\.0000 billed/.test(zr.stderr), `${JSON.stringify(zp?.usage)} ${zr.stderr}`);
  await zm.close();

  // Non-numeric ticks -> ignored, clean fallback (never coerce, never crash).
  const nm = createMockServer({ costTicks: 'not-a-number' });
  const nport = await nm.listen();
  const nr = await runCli(['ask', 'bad ticks probe', '--json'], {
    GROK_API_KEY: 'xai-test-key',
    GROK_BASE_URL: `http://127.0.0.1:${nport}/v1`,
    GROKSCOPE_HOME: path.join(TMP_HOME, 'badticks-home'),
  });
  let np = null;
  try { np = JSON.parse(nr.stdout); } catch {}
  check(
    'non-numeric ticks -> ignored, falls back to the estimate',
    nr.code === 0 && np?.usage.costExact === false && np?.usage.costUsd === np?.usage.estimatedCostUsd && /~\$0\.0049 \(estimated\)/.test(nr.stderr),
    `${JSON.stringify(np?.usage)} ${nr.stderr}`,
  );
  await nm.close();
}

// 26. X Search per-item cost (1.5.0): since 2026-09-21 xAI bills X Search at
// $5/1k posts and $10/1k user profiles fetched, reported as
// usage.server_side_tool_usage_details.x_posts_fetched / x_users_fetched.
{
  const grok = await import(new URL('../dist/grok.js', import.meta.url).href);
  const fmt = await import(new URL('../dist/formatter.js', import.meta.url).href);
  const counts = (details) => {
    const u = grok.parseResponse({ usage: { server_side_tool_usage_details: details } }).usage;
    return [u.xPostsFetched, u.xUsersFetched];
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('fetch counts -> parsed from server_side_tool_usage_details', same(counts({ x_posts_fetched: 184, x_users_fetched: 0 }), [184, 0]));
  check(
    'fetch counts -> negative, fractional, string and null are ignored',
    [-1, 1.5, '184', null, 1e24].every((v) => same(counts({ x_posts_fetched: v, x_users_fetched: v }), [undefined, undefined])),
  );
  check('fetch counts -> absent details block leaves both undefined', same(counts(undefined), [undefined, undefined]));
  check('fetch counts -> non-object details block leaves both undefined', [null, 'x', 7].every((d) => same(counts(d), [undefined, undefined])));
  check('fetch counts -> profiles need a valid posts count', same(counts({ x_posts_fetched: -4, x_users_fetched: 3 }), [undefined, undefined]));
  check('fetch counts -> JSON -0 reads as 0', Object.is(counts(JSON.parse('{"x_posts_fetched":-0}'))[0], 0));
  check(
    'xSearchCostUsd -> undefined without a posts count, missing profiles treated as 0',
    fmt.xSearchCostUsd({}) === undefined &&
      fmt.xSearchCostUsd(undefined) === undefined &&
      fmt.xSearchCostUsd({ xUsersFetched: 3 }) === undefined &&
      fmt.xSearchCostUsd({ xPostsFetched: 2 }) === 0.01 &&
      fmt.xSearchCostUsd({ xPostsFetched: 1000, xUsersFetched: 1000 }) === 15,
  );

  async function withMock(mockOpts, home, fn) {
    const m = createMockServer(mockOpts);
    const port = await m.listen();
    const env = {
      GROK_API_KEY: 'xai-test-key',
      GROK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      GROKSCOPE_HOME: path.join(TMP_HOME, home),
    };
    try {
      return await fn((args) => runCli(args, env));
    } finally {
      await m.close();
    }
  }
  const costLine = (stderr) => stderr.split(/\r?\n/).find((l) => / tokens/.test(l));
  const json = (stdout) => {
    try { return JSON.parse(stdout); } catch { return null; }
  };

  // The worked example: $1.124 billed, 184 posts + 3 profiles = $0.95 of it.
  const WORKED = '1,600 tokens · $1.1240 billed · X Search 184 posts, 3 profiles (~$0.95)';
  await withMock({ costTicks: 11_240_000_000 }, 'xsearch-home', async (cli) => {
    const r = await cli(['ask', 'x search cost probe', '--json']);
    check('x search -> worked-example cost line', costLine(r.stderr) === WORKED, r.stderr);
    const u = json(r.stdout)?.usage;
    check(
      'x search -> --json xPostsFetched, xUsersFetched, xSearchCostUsd',
      u?.xPostsFetched === 184 && u?.xUsersFetched === 3 && u?.xSearchCostUsd === 0.95,
      JSON.stringify(u),
    );
    check(
      'x search -> existing --json cost fields unchanged',
      u?.costUsd === 1.124 && u?.costExact === true && u?.estimatedCostUsd === 0.00488,
      JSON.stringify(u),
    );
    const hit = await cli(['ask', 'x search cost probe']);
    check('x search -> cache hit reproduces the breakdown', /from cache/.test(hit.stderr) && costLine(hit.stderr) === WORKED, hit.stderr);
    const hist = await cli(['history', '1', '--json']);
    check(
      'x search -> history <n> reproduces the breakdown',
      costLine(hist.stderr) === WORKED && json(hist.stdout)?.usage.xSearchCostUsd === 0.95,
      hist.stderr,
    );
    const list = await cli(['history']);
    check("history -> list shows each run's billed total", /  1\. ask      \d{4}-\d\d-\d\d  \$1\.1240   x search cost probe/.test(list.stdout), list.stdout);
  });

  await withMock({ costTicks: 11_240_000_000 }, 'xsearch-watch-home', async (cli) => {
    await cli(['watch', 'add', 'rust']);
    const r = await cli(['watch', 'run', '--json']);
    const u = json(r.stdout)?.usage;
    check(
      'x search -> watch run prints the breakdown and the --json fields',
      costLine(r.stderr) === WORKED && u?.xPostsFetched === 184 && u?.xUsersFetched === 3 && u?.xSearchCostUsd === 0.95,
      `${JSON.stringify(u)} ${r.stderr}`,
    );
  });

  // The e2e mock's default bill ($0.0061) is below X Search's list price, as a
  // discount or credit would make it: the counts stay, the figure goes.
  await withMock({}, 'xsearch-overbill-home', async (cli) => {
    const r = await cli(['ask', 'over bill probe', '--json']);
    check(
      'x search share above the exact bill -> counts without the figure',
      costLine(r.stderr) === '1,600 tokens · $0.0061 billed · X Search 184 posts, 3 profiles' &&
        json(r.stdout)?.usage.xSearchCostUsd === 0.95,
      r.stderr,
    );
  });

  // Counts absent (proxy, bodies cached by 1.4.0): exactly the 1.4.0 output.
  await withMock({ omitFetchCounts: true }, 'nocounts-home', async (cli) => {
    const r = await cli(['ask', 'no counts probe', '--json']);
    check('no counts -> byte-identical 1.4.0 billed line', costLine(r.stderr) === '1,600 tokens · $0.0061 billed', r.stderr);
    const u = json(r.stdout)?.usage;
    check(
      'no counts -> --json usage has exactly the 1.4.0 keys',
      same(Object.keys(u ?? {}), ['inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'costExact', 'estimatedCostUsd']),
      JSON.stringify(u),
    );
    const hit = await cli(['ask', 'no counts probe']);
    check('no counts -> cache hit keeps the 1.4.0 line', costLine(hit.stderr) === '1,600 tokens · $0.0061 billed', hit.stderr);
  });
  await withMock({ omitFetchCounts: true, omitCostTicks: true }, 'proxy-home', async (cli) => {
    const r = await cli(['ask', 'proxy probe']);
    check('no counts, no ticks -> byte-identical 1.4.0 estimated line', costLine(r.stderr) === '1,600 tokens · ~$0.0049 (estimated)', r.stderr);
    const list = await cli(['history']);
    check('history -> list marks an estimated total with ~', /\d  ~\$0\.0049  proxy probe/.test(list.stdout), list.stdout);
  });

  await withMock({ omitCostTicks: true }, 'counts-noticks-home', async (cli) => {
    const r = await cli(['ask', 'counts without ticks probe']);
    check(
      'counts, no ticks -> estimated total plus the X Search segment',
      costLine(r.stderr) === '1,600 tokens · ~$0.0049 (estimated) · X Search 184 posts, 3 profiles (~$0.95)',
      r.stderr,
    );
  });

  await withMock({ costTicks: 11_240_000_000, xUsersFetched: 0 }, 'zero-profiles-home', async (cli) => {
    const r = await cli(['ask', 'zero profiles probe']);
    check('zero profiles -> profile clause omitted', / · X Search 184 posts \(~\$0\.92\)$/.test(costLine(r.stderr)), r.stderr);
  });
  await withMock({ xPostsFetched: 0, xUsersFetched: 0 }, 'zero-counts-home', async (cli) => {
    const r = await cli(['ask', 'zero counts probe', '--json']);
    check('zero counts -> "X Search 0 posts (~$0.00)"', / · X Search 0 posts \(~\$0\.00\)$/.test(costLine(r.stderr)), r.stderr);
    check('zero counts -> --json xSearchCostUsd is a real 0', json(r.stdout)?.usage.xSearchCostUsd === 0, r.stdout.slice(-300));
  });
  await withMock({ costTicks: 1_000_000_000_000, xPostsFetched: 12_346, xUsersFetched: 1 }, 'plural-home', async (cli) => {
    const r = await cli(['ask', 'plural probe']);
    check('counts -> singular noun and thousands separator', / · X Search 12,346 posts, 1 profile \(~\$61\.74\)$/.test(costLine(r.stderr)), r.stderr);
  });

  await withMock({ xPostsFetched: -4, xUsersFetched: 3 }, 'bad-counts-home', async (cli) => {
    const r = await cli(['ask', 'bad counts probe', '--json']);
    const u = json(r.stdout)?.usage;
    check(
      'invalid posts count -> no segment and no X Search keys, even with valid profiles',
      r.code === 0 && costLine(r.stderr) === '1,600 tokens · $0.0061 billed' && u && !('xPostsFetched' in u) && !('xUsersFetched' in u) && !('xSearchCostUsd' in u),
      `${JSON.stringify(u)} ${r.stderr}`,
    );
  });
  await withMock({ costTicks: 11_240_000_000, xUsersFetched: '3' }, 'bad-profiles-home', async (cli) => {
    const r = await cli(['ask', 'bad profiles probe', '--json']);
    const u = json(r.stdout)?.usage;
    check(
      'invalid profiles count -> posts only, xUsersFetched left out',
      / · X Search 184 posts \(~\$0\.92\)$/.test(costLine(r.stderr)) && u?.xPostsFetched === 184 && !('xUsersFetched' in u) && u?.xSearchCostUsd === 0.92,
      `${JSON.stringify(u)} ${r.stderr}`,
    );
  });
}

// 27. --version reports the published package version.
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const r = await runCli(['--version'], {});
  check('version -> --version matches package.json', r.stdout.trim() === pkg.version, `${r.stdout.trim()} vs ${pkg.version}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
