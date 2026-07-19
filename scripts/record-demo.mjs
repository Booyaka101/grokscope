/**
 * Record the demo fixtures used by `grokscope demo`.
 *
 * Runs the three canonical queries against the REAL xAI API and saves each raw
 * `/v1/responses` body (plus small metadata) to `demo/<name>.json`. Those files
 * ship in the npm package so anyone can `grokscope demo` with no key or credits.
 *
 * Usage:  GROK_API_KEY=xai-...  npm run demo:record     (costs ~$0.60 of credit)
 *
 * Re-run whenever you want fresher samples. The request bodies here mirror
 * exactly what the CLI sends for `ask` / `compare` / `trending`.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  askSystem,
  COMPARE_SYSTEM,
  TRENDING_SYSTEM,
  comparePrompt,
  trendingPrompt,
  daysAgoISO,
  WINDOW_DAYS,
} from '../dist/prompts.js';

const key = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY;
if (!key) {
  console.error('Set GROK_API_KEY first (get one at https://console.x.ai, then add credits).');
  process.exit(1);
}
const base = (process.env.GROK_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '');
const model = process.env.GROK_MODEL ?? 'grok-4.5';
const today = new Date().toISOString().slice(0, 10);

const DEMOS = [
  {
    name: 'ask',
    command: 'ask',
    query: 'bun vs node in 2026',
    days: WINDOW_DAYS.ask,
    system: askSystem(WINDOW_DAYS.ask),
    user: 'bun vs node in 2026',
    runLive: 'grokscope ask "bun vs node in 2026"',
  },
  {
    name: 'compare',
    command: 'compare',
    query: 'react vs solidjs',
    days: WINDOW_DAYS.compare,
    system: COMPARE_SYSTEM,
    user: comparePrompt('react', 'solidjs', WINDOW_DAYS.compare),
    runLive: 'grokscope compare react solidjs',
  },
  {
    name: 'trending',
    command: 'trending',
    query: 'rust, typescript, go',
    days: WINDOW_DAYS.trending,
    system: TRENDING_SYSTEM,
    user: trendingPrompt(['rust', 'typescript', 'go'], WINDOW_DAYS.trending),
    runLive: 'grokscope trending --topics "rust,typescript,go"',
  },
];

const outDir = fileURLToPath(new URL('../demo/', import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const d of DEMOS) {
  const body = {
    model,
    instructions: d.system,
    input: [{ role: 'user', content: d.user }],
    tools: [{ type: 'x_search', from_date: daysAgoISO(d.days) }],
  };
  process.stderr.write(`recording ${d.name} — ${d.runLive} ...\n`);
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`${d.name}: HTTP ${res.status} — ${await res.text().catch(() => '')}`);
    process.exit(1);
  }
  const response = await res.json();
  const fixture = {
    meta: {
      command: d.command,
      query: d.query,
      days: d.days,
      recordedAt: today,
      model,
      runLive: d.runLive,
    },
    response,
  };
  writeFileSync(`${outDir}${d.name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
  const usage = response.usage ?? {};
  const cost =
    usage.input_tokens && usage.output_tokens
      ? ` (~$${((usage.input_tokens * 2 + usage.output_tokens * 6) / 1_000_000).toFixed(4)})`
      : '';
  console.log(`  wrote demo/${d.name}.json${cost}`);
}
console.log('\nDone. Commit demo/*.json and ship. Try it:  node dist/cli.js demo --all');
