#!/usr/bin/env node
/**
 * grokscope — real-time developer community intelligence from X,
 * powered by Grok 4.5's native x_search tool.
 */

import { Command } from 'commander';
import {
  askGrok,
  checkApi,
  resolvedModel,
  resolvedBaseUrl,
  FORBIDDEN_HINT,
  GrokApiError,
  type XSearchConfig,
} from './grok.js';
import {
  askSystem,
  COMPARE_SYSTEM,
  TRENDING_SYSTEM,
  comparePrompt,
  trendingPrompt,
  daysAgoISO,
  WINDOW_DAYS,
} from './prompts.js';
import { renderResult, renderMarkdownDoc, renderJson } from './formatter.js';

const VERSION = '1.0.0';
const GET_KEY_MSG = 'Get your free key (includes $20 credit) at https://console.x.ai';

function getApiKey(): string | undefined {
  return process.env.GROK_API_KEY ?? process.env.XAI_API_KEY;
}

function requireApiKey(): string {
  const key = getApiKey();
  if (!key) {
    console.error(GET_KEY_MSG);
    process.exit(1);
  }
  return key;
}

interface SharedOpts {
  handles?: string;
  exclude?: string;
  days?: string;
  images?: boolean;
  videos?: boolean;
  json?: boolean;
  md?: boolean;
}

function resolveDays(opts: SharedOpts, defaultDays: number): number {
  const days = opts.days ? Number(opts.days) : defaultDays;
  if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    console.error(`Invalid --days value: ${opts.days} (expected a positive whole number)`);
    process.exit(1);
  }
  return days;
}

function xSearchFromOpts(opts: SharedOpts, days: number): XSearchConfig {
  const splitList = (s?: string) =>
    s
      ?.split(',')
      .map((h) => h.trim().replace(/^@/, ''))
      .filter(Boolean);
  return {
    fromDate: daysAgoISO(days),
    allowedHandles: splitList(opts.handles),
    excludedHandles: splitList(opts.exclude),
    imageUnderstanding: opts.images,
    videoUnderstanding: opts.videos,
  };
}

/** Minimal stderr spinner so long agentic searches don't look hung. */
function startSpinner(label: string): () => void {
  if (!process.stderr.isTTY) {
    process.stderr.write(`${label}...\n`);
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    process.stderr.write(`\r${frames[i++ % frames.length]} ${label}... ${secs}s `);
  }, 100);
  return () => {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  };
}

interface RunMeta {
  command: string;
  query: string;
  days: number;
}

async function run(system: string, user: string, opts: SharedOpts, meta: RunMeta): Promise<void> {
  if (opts.json && opts.md) {
    console.error('--json and --md are mutually exclusive — pick one.');
    process.exit(1);
  }
  const apiKey = requireApiKey();
  const xSearch = xSearchFromOpts(opts, meta.days);
  const stop = startSpinner(`Searching X (last ${meta.days} days) via ${resolvedModel()}`);
  try {
    const result = await askGrok({ system, user, xSearch }, apiKey);
    stop();
    if (!result.content.trim()) {
      console.error('The model returned an empty response. Try rephrasing your query.');
      process.exit(1);
    }
    if (opts.json) {
      process.stdout.write(
        renderJson(result, {
          command: meta.command,
          query: meta.query,
          model: resolvedModel(),
          searchWindowDays: meta.days,
          version: VERSION,
        }),
      );
      return;
    }
    process.stdout.write(opts.md ? renderMarkdownDoc(result) : renderResult(result));
    // BYOK transparency: show what this query cost (grok-4.5: $2/M in, $6/M out)
    const { inputTokens, outputTokens } = result.usage ?? {};
    if (inputTokens !== undefined && outputTokens !== undefined) {
      const usd = (inputTokens * 2 + outputTokens * 6) / 1_000_000;
      process.stderr.write(
        `\x1b[2m${(inputTokens + outputTokens).toLocaleString()} tokens · ~$${usd.toFixed(4)}\x1b[22m\n`,
      );
    }
  } catch (err) {
    stop();
    if (err instanceof GrokApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

const program = new Command();

program
  .name('grokscope')
  .description(
    'Real-time developer community intelligence from X, powered by Grok 4.5 x_search.\nRequires GROK_API_KEY (get one at https://console.x.ai).',
  )
  .version(VERSION)
  .addHelpText(
    'after',
    `
Examples:
  $ grokscope ask "bun vs node in 2026"
  $ grokscope ask "htmx in production" --handles htmx_org --days 60
  $ grokscope compare react solidjs
  $ grokscope trending --topics "rust,typescript,go"
  $ grokscope trending --topics "our-sdk" --json > report.json   # CI / scripts
  $ grokscope ask "state of deno" --md >> newsletter.md          # clean markdown
  $ grokscope doctor                                             # check your setup

Environment:
  GROK_API_KEY   xAI API key (required; XAI_API_KEY also works)
  GROK_MODEL     override model (default: grok-4.5)
  GROK_BASE_URL  override API base (default: https://api.x.ai/v1)
  NO_COLOR       disable ANSI styling`,
  );

const withSharedOpts = (cmd: Command): Command =>
  cmd
    .option('--handles <list>', 'comma-separated X handles to restrict search to')
    .option('--exclude <list>', 'comma-separated X handles to exclude')
    .option('--days <n>', 'how many days back to search')
    .option('--images', 'let Grok analyze images in posts')
    .option('--videos', 'let Grok analyze videos in posts')
    .option('--json', 'machine-readable JSON output (for CI/scripts)')
    .option('--md', 'clean markdown output (for newsletters/notes)');

withSharedOpts(
  program
    .command('ask')
    .description('ask a developer question, answered from live X posts')
    .argument('<question...>', 'the question to research'),
).action(async (questionParts: string[], opts: SharedOpts) => {
  const question = questionParts.join(' ');
  const days = resolveDays(opts, WINDOW_DAYS.ask);
  await run(askSystem(days), question, opts, { command: 'ask', query: question, days });
});

withSharedOpts(
  program
    .command('compare')
    .description('head-to-head community sentiment for two technologies')
    .argument('<techA>', 'first technology')
    .argument('<techB>', 'second technology'),
).action(async (techA: string, techB: string, opts: SharedOpts) => {
  const days = resolveDays(opts, WINDOW_DAYS.compare);
  await run(COMPARE_SYSTEM, comparePrompt(techA, techB, days), opts, {
    command: 'compare',
    query: `${techA} vs ${techB}`,
    days,
  });
});

withSharedOpts(
  program
    .command('trending')
    .description('weekly buzz report per topic')
    .requiredOption('--topics <list>', 'comma-separated topics'),
).action(async (opts: SharedOpts & { topics: string }) => {
  const topics = opts.topics
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (topics.length === 0) {
    console.error('No topics given. Example: grokscope trending --topics "rust,typescript,go"');
    process.exit(1);
  }
  const days = resolveDays(opts, WINDOW_DAYS.trending);
  await run(TRENDING_SYSTEM, trendingPrompt(topics, days), opts, {
    command: 'trending',
    query: topics.join(', '),
    days,
  });
});

program
  .command('doctor')
  .description('check your setup: API key, connectivity, model availability (free — no tokens spent)')
  .action(async () => {
    const rows: Array<[boolean | 'warn', string]> = [];
    let forbiddenHint = false;
    console.log(`GrokScope doctor v${VERSION}\n`);

    const key = getApiKey();
    if (!key) {
      console.log('  FAIL  API key: not set');
      console.log(`\n${GET_KEY_MSG}`);
      console.log("Then (PowerShell):  $env:GROK_API_KEY = 'xai-...'");
      console.log('     (bash/zsh):    export GROK_API_KEY=xai-...');
      process.exit(1);
    }
    const masked = `${key.slice(0, 6)}…${key.slice(-4)}`;
    rows.push([true, `API key: set (${masked})`]);

    const health = await checkApi(key);
    if (!health.reachable) {
      rows.push([false, `API reachable: no — ${health.error ?? 'unknown error'} (${resolvedBaseUrl()})`]);
    } else {
      rows.push([true, `API reachable: ${resolvedBaseUrl()} (${health.latencyMs} ms)`]);
      if (health.forbidden) {
        rows.push([
          false,
          `key recognised, but this account may not make the call (HTTP 403)` +
            `${health.detail ? ` — the API says: ${health.detail}` : ''}`,
        ]);
        forbiddenHint = true;
      } else if (health.keyValid === false) {
        rows.push([
          false,
          `key valid: no (HTTP ${health.status}) — check the key at https://console.x.ai` +
            `${health.detail ? ` (${health.detail})` : ''}`,
        ]);
      } else if (health.keyValid === true) {
        rows.push([true, 'key valid: yes']);
        const model = resolvedModel();
        if (!health.models?.length) {
          rows.push(['warn', `model ${model}: could not verify (model list unavailable)`]);
        } else if (health.models.includes(model)) {
          rows.push([true, `model ${model}: available`]);
        } else {
          rows.push([
            false,
            `model ${model}: not in your account's model list (${health.models.slice(0, 5).join(', ')}…) — check GROK_MODEL`,
          ]);
        }
      } else {
        rows.push(['warn', `key valid: could not verify (${health.error ?? `HTTP ${health.status}`})`]);
      }
    }

    for (const [ok, msg] of rows) {
      console.log(`  ${ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'}  ${msg}`);
    }
    if (forbiddenHint) console.log(`\n${FORBIDDEN_HINT}`);
    const failed = rows.some(([ok]) => ok === false);
    console.log(
      failed
        ? '\nSomething is off — fix the FAIL lines above and re-run `grokscope doctor`.'
        : '\nEverything looks good — try:  grokscope ask "bun vs node in 2026"',
    );
    process.exit(failed ? 1 : 0);
  });

program.parseAsync(process.argv);
