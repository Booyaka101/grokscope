#!/usr/bin/env node
/**
 * grokscope — real-time developer community intelligence from X,
 * powered by Grok 4.5's native x_search tool.
 */

import { Command } from 'commander';
import {
  askGrok,
  checkApi,
  parseResponse,
  resolvedModel,
  resolvedBaseUrl,
  FORBIDDEN_HINT,
  GrokApiError,
  type GrokResult,
  type XSearchConfig,
} from './grok.js';
import {
  askSystem,
  compareSystem,
  trendingSystem,
  releaseSystem,
  painSystem,
  comparePrompt,
  trendingPrompt,
  releasePrompt,
  painPrompt,
  daysAgoISO,
  WINDOW_DAYS,
} from './prompts.js';
import { renderResult, renderMarkdownDoc, renderJson, estimateCostUsd } from './formatter.js';
import { runDemo, DEMO_NAMES, type DemoName } from './demo.js';
import * as cache from './cache.js';
import * as watch from './watch.js';

const VERSION = '1.3.0';
// A new xAI team starts with zero credits and 403s on every call, so getting a
// key is only half the setup — say so here rather than letting the first call fail.
const GET_KEY_MSG =
  'Get a key at https://console.x.ai — then add credits to your team there (a new team has none).';

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
  fresh?: boolean;
  maxAge?: string;
}

function resolveDays(opts: SharedOpts, defaultDays: number): number {
  const days = opts.days ? Number(opts.days) : defaultDays;
  if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days) || days > 365) {
    console.error(`Invalid --days value: ${opts.days} (expected a whole number between 1 and 365)`);
    process.exit(1);
  }
  return days;
}

/** Split a comma list of handles, trimming whitespace and a leading @. */
function splitHandles(s?: string): string[] {
  return (
    s
      ?.split(',')
      .map((h) => h.trim().replace(/^@/, ''))
      .filter(Boolean) ?? []
  );
}

const MAX_HANDLES = 20;

/**
 * Validate --handles/--exclude before any network setup, with flag-named errors.
 * xAI caps each list at 20 and forbids combining them; catch both here so the
 * user sees a clear message before we ever ask for an API key.
 */
function validateHandleOpts(opts: SharedOpts): void {
  const handles = splitHandles(opts.handles);
  const exclude = splitHandles(opts.exclude);
  if (handles.length && exclude.length) {
    console.error("--handles and --exclude can't be combined.");
    process.exit(1);
  }
  if (handles.length > MAX_HANDLES) {
    console.error(`--handles accepts at most ${MAX_HANDLES} handles (got ${handles.length}).`);
    process.exit(1);
  }
  if (exclude.length > MAX_HANDLES) {
    console.error(`--exclude accepts at most ${MAX_HANDLES} handles (got ${exclude.length}).`);
    process.exit(1);
  }
}

/** Resolve --max-age (hours) to ms; default 24h. */
function resolveMaxAgeMs(opts: SharedOpts): number {
  const hours = opts.maxAge !== undefined ? Number(opts.maxAge) : 24;
  if (!Number.isFinite(hours) || hours < 0) {
    console.error(`Invalid --max-age value: ${opts.maxAge} (expected a non-negative number of hours)`);
    process.exit(1);
  }
  return hours * 3_600_000;
}

function xSearchFromOpts(opts: SharedOpts, days: number): XSearchConfig {
  const allowed = splitHandles(opts.handles);
  const excluded = splitHandles(opts.exclude);
  return {
    fromDate: daysAgoISO(days),
    allowedHandles: allowed.length ? allowed : undefined,
    excludedHandles: excluded.length ? excluded : undefined,
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

/** Dim styling for stderr notes — respects NO_COLOR and non-TTY output. */
function stderrDim(s: string): string {
  const on = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  return on ? `\x1b[2m${s}\x1b[22m` : s;
}

interface RunMeta {
  command: string;
  query: string;
  days: number;
}

/** Render a result to stdout in the format the flags select (shared by live/cache/history). */
function renderOutput(result: GrokResult, opts: SharedOpts, meta: RunMeta, model: string): void {
  if (opts.json) {
    process.stdout.write(
      renderJson(result, {
        command: meta.command,
        query: meta.query,
        model,
        searchWindowDays: meta.days,
        version: VERSION,
      }),
    );
    return;
  }
  process.stdout.write(opts.md ? renderMarkdownDoc(result) : renderResult(result));
}

/** BYOK transparency: estimate what this query cost. Tokens are the API's own
 * count; rates come from a per-model table (finding #5) — an unknown GROK_MODEL
 * omits the dollar figure rather than misreporting it. console.x.ai is the truth. */
function printCostLine(model: string, result: GrokResult): void {
  const { inputTokens, outputTokens } = result.usage ?? {};
  if (inputTokens === undefined || outputTokens === undefined) return;
  const usd = estimateCostUsd(model, inputTokens, outputTokens);
  const total = (inputTokens + outputTokens).toLocaleString();
  const line = usd !== undefined ? `${total} tokens · ~$${usd.toFixed(4)}` : `${total} tokens`;
  process.stderr.write(`${stderrDim(line)}\n`);
}

async function run(system: string, user: string, opts: SharedOpts, meta: RunMeta): Promise<void> {
  if (opts.json && opts.md) {
    console.error('--json and --md are mutually exclusive — pick one.');
    process.exit(1);
  }
  // Flag-named validation before we ever ask for a key (findings #4, #9).
  validateHandleOpts(opts);
  const apiKey = requireApiKey();
  const xSearch = xSearchFromOpts(opts, meta.days);
  const model = resolvedModel();

  // Cache: an identical request (same model/system/user/window) re-renders for
  // free. Format-only changes (--json/--md) keep the same key, so they hit too.
  const key = cache.cacheKey({ model, system, user, xSearch });
  if (!opts.fresh) {
    const hit = cache.get(key, resolveMaxAgeMs(opts));
    if (hit) {
      renderOutput(parseResponse(hit.response), opts, meta, model);
      process.stderr.write(`${stderrDim('(from cache — run with --fresh to refresh)')}\n`);
      return;
    }
  }

  const stop = startSpinner(`Searching X (last ${meta.days} days) via ${model}`);
  try {
    const { result, raw } = await askGrok({ system, user, xSearch }, apiKey);
    stop();
    if (!result.content.trim()) {
      console.error('The model returned an empty response. Try rephrasing your query.');
      process.exit(1);
    }
    cache.put(key, raw, {
      command: meta.command,
      query: meta.query,
      model,
      days: meta.days,
      createdAt: new Date().toISOString(),
    });
    if (result.incomplete) {
      console.error('⚠ Response was truncated (likely a token limit) — try a narrower query.');
    }
    renderOutput(result, opts, meta, model);
    printCostLine(model, result);
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
  $ grokscope release nextjs 15                                  # reaction to a release
  $ grokscope pain webpack                                       # ranked pain points
  $ grokscope watch add rust typescript                          # start tracking topics
  $ grokscope watch run                                          # snapshot + what moved
  $ grokscope trending --topics "our-sdk" --json > report.json   # CI / scripts
  $ grokscope ask "state of deno" --md >> newsletter.md          # clean markdown
  $ grokscope ask "state of deno" --fresh                        # bypass the cache
  $ grokscope history                                            # recent cached results
  $ grokscope history 1                                          # re-print one for free
  $ grokscope cache clear --older-than 48                        # prune the cache
  $ grokscope doctor                                             # check your setup

Environment:
  GROK_API_KEY   xAI API key (required; XAI_API_KEY also works)
  GROK_MODEL     override model (default: grok-4.5)
  GROK_BASE_URL  override API base (default: https://api.x.ai/v1)
  GROKSCOPE_HOME cache directory (default: ~/.grokscope)
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
    .option('--md', 'clean markdown output (for newsletters/notes)')
    .option('--fresh', 'bypass the cache and fetch fresh (overwrites the cached copy)')
    .option('--max-age <hours>', 'ignore cached results older than this many hours (default 24)');

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
  await run(compareSystem(days), comparePrompt(techA, techB, days), opts, {
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
  await run(trendingSystem(days), trendingPrompt(topics, days), opts, {
    command: 'trending',
    query: topics.join(', '),
    days,
  });
});

withSharedOpts(
  program
    .command('release')
    .description('community reaction to a release: praise, breakage, migration pain, upgrade verdict')
    .argument('<project>', 'the project that shipped (e.g. nextjs, bun, react)')
    .argument('[version]', 'a specific version (e.g. 15, 2.0) — omit for the latest release'),
).action(async (project: string, version: string | undefined, opts: SharedOpts) => {
  const days = resolveDays(opts, WINDOW_DAYS.release);
  const query = version ? `${project} ${version}` : project;
  await run(releaseSystem(days), releasePrompt(project, version, days), opts, {
    command: 'release',
    query,
    days,
  });
});

withSharedOpts(
  program
    .command('pain')
    .description('ranked digest of the pain points developers report about a technology')
    .argument('<tech...>', 'the technology to research'),
).action(async (techParts: string[], opts: SharedOpts) => {
  const tech = techParts.join(' ');
  const days = resolveDays(opts, WINDOW_DAYS.pain);
  await run(painSystem(days), painPrompt(tech, days), opts, {
    command: 'pain',
    query: tech,
    days,
  });
});

const watchCmd = program
  .command('watch')
  .description('track community sentiment for a set of topics over time (snapshots + what moved)');

watchCmd
  .command('list', { isDefault: true })
  .description('show the watched topics — free, reads local files only')
  .action(() => {
    const topics = watch.loadTopics();
    if (topics.length === 0) {
      console.log('No watched topics yet. Add some:  grokscope watch add rust typescript');
      return;
    }
    console.log(`Watched topics (${cache.grokscopeHome()}):\n`);
    topics.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    console.log('\nTake a snapshot:  grokscope watch run');
  });

watchCmd
  .command('add')
  .description('add topics to the watch list')
  .argument('<topics...>', 'topics to watch (space- or comma-separated)')
  .action((raw: string[]) => {
    const topics = watch.loadTopics();
    const have = new Set(topics.map((t) => t.toLowerCase()));
    const incoming = raw
      .flatMap((t) => t.split(','))
      .map((t) => t.trim())
      .filter(Boolean);
    for (const t of incoming) {
      if (have.has(t.toLowerCase())) continue;
      have.add(t.toLowerCase());
      topics.push(t);
    }
    watch.saveTopics(topics);
    console.log(`Watching ${topics.length} topic${topics.length === 1 ? '' : 's'}: ${topics.join(', ')}`);
    console.log('Take a snapshot:  grokscope watch run');
  });

watchCmd
  .command('rm')
  .alias('remove')
  .description('remove a topic from the watch list')
  .argument('<topic>', 'the topic to stop watching')
  .action((topic: string) => {
    const topics = watch.loadTopics();
    const next = topics.filter((t) => t.toLowerCase() !== topic.trim().toLowerCase());
    if (next.length === topics.length) {
      console.error(`"${topic}" is not on the watch list. Run \`grokscope watch\` to see it.`);
      process.exit(1);
    }
    watch.saveTopics(next);
    console.log(next.length ? `Watching: ${next.join(', ')}` : 'Watch list is now empty.');
  });

withSharedOpts(
  watchCmd
    .command('run')
    .description('take a sentiment snapshot of every watched topic and diff it against the last run'),
).action(async (opts: SharedOpts) => {
  if (opts.json && opts.md) {
    console.error('--json and --md are mutually exclusive — pick one.');
    process.exit(1);
  }
  validateHandleOpts(opts);
  const topics = watch.loadTopics();
  if (topics.length === 0) {
    console.error('No watched topics yet. Add some first:  grokscope watch add rust typescript');
    process.exit(1);
  }
  const apiKey = requireApiKey();
  const days = resolveDays(opts, WINDOW_DAYS.trending);
  const system = trendingSystem(days);
  const user = trendingPrompt(topics, days);
  const xSearch = xSearchFromOpts(opts, days);
  const model = resolvedModel();

  // A snapshot is a fresh sample by definition, so the cache is never read here —
  // only written, so `grokscope history` can re-print the report for free.
  const stop = startSpinner(
    `Snapshotting ${topics.length} topic${topics.length === 1 ? '' : 's'} (last ${days} days) via ${model}`,
  );
  try {
    const { result, raw } = await askGrok({ system, user, xSearch }, apiKey);
    stop();
    if (!result.content.trim()) {
      console.error('The model returned an empty response. Try again, or trim the topic list.');
      process.exit(1);
    }
    cache.put(cache.cacheKey({ model, system, user, xSearch }), raw, {
      command: 'watch',
      query: topics.join(', '),
      model,
      days,
      createdAt: new Date().toISOString(),
    });
    if (result.incomplete) {
      console.error('⚠ Response was truncated (likely a token limit) — try fewer topics.');
    }
    const readings = watch.parseTopicReadings(result.content, topics);
    const prev = watch.loadSnapshots().at(-1);
    const deltas = watch.diffReadings(readings, prev);
    watch.appendSnapshot({ at: new Date().toISOString(), days, model, readings });

    if (opts.json) {
      process.stdout.write(
        renderJson(
          result,
          { command: 'watch', query: topics.join(', '), model, searchWindowDays: days, version: VERSION },
          { watch: { previousSnapshotAt: prev?.at, topics: deltas } },
        ),
      );
    } else {
      process.stdout.write(opts.md ? renderMarkdownDoc(result) : renderResult(result));
      if (prev) {
        process.stdout.write(`\n${watch.renderDeltas(deltas, prev.at)}\n`);
      } else {
        process.stderr.write(
          `${stderrDim(
            `First snapshot recorded (${topics.length} topic${topics.length === 1 ? '' : 's'}) — run \`grokscope watch run\` again later to see what moved.`,
          )}\n`,
        );
      }
    }
    printCostLine(model, result);
  } catch (err) {
    stop();
    if (err instanceof GrokApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
});

watchCmd
  .command('log')
  .description('show stored snapshots, oldest first — free, reads local files only')
  .argument('[topic]', 'only show readings for this topic')
  .option('--json', 'machine-readable JSON output (for CI/scripts)')
  .action((topic: string | undefined, opts: { json?: boolean }) => {
    let snaps = watch.loadSnapshots();
    if (topic) {
      snaps = snaps
        .map((s) => ({
          ...s,
          readings: s.readings.filter((r) => r.topic.toLowerCase() === topic.toLowerCase()),
        }))
        .filter((s) => s.readings.length > 0);
    }
    if (snaps.length === 0) {
      console.log(
        topic
          ? `No snapshots for "${topic}" yet — is it watched? (grokscope watch)`
          : 'No snapshots yet — take one:  grokscope watch run',
      );
      return;
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(snaps, null, 2)}\n`);
      return;
    }
    for (const s of snaps) {
      const row = s.readings.map((r) => `${r.topic}: ${r.sentiment}/${r.momentum}`).join('   ');
      console.log(`  ${s.at.slice(0, 10)}  ${row}`);
    }
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
          // /models can omit models that are still callable, so an absence is a
          // warning, not a failure — don't fail a working setup on it (finding #8).
          rows.push([
            'warn',
            `model ${model}: not listed by /models (${health.models.slice(0, 5).join(', ')}…) — /models can omit callable models; check GROK_MODEL if calls fail`,
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

program
  .command('history')
  .description('list recently cached results, or re-print one by index — free, no tokens spent')
  .argument('[index]', 're-print the cached result at this index (from the list)')
  .option('--json', 'machine-readable JSON output (for CI/scripts)')
  .option('--md', 'clean markdown output (for newsletters/notes)')
  .action((index: string | undefined, opts: { json?: boolean; md?: boolean }) => {
    if (opts.json && opts.md) {
      console.error('--json and --md are mutually exclusive — pick one.');
      process.exit(1);
    }
    const entries = cache.list();
    if (index === undefined) {
      if (entries.length === 0) {
        console.log('No cached results yet — run ask/compare/trending to populate the cache.');
        return;
      }
      console.log(`Cached results (${cache.grokscopeHome()}):\n`);
      entries.forEach((e, i) => {
        const when = e.meta.createdAt.slice(0, 10);
        console.log(`  ${String(i + 1).padStart(2)}. ${e.meta.command.padEnd(8)} ${when}  ${e.meta.query}`);
      });
      console.log(`\nRe-print one for free:  grokscope history <index>`);
      return;
    }
    const n = Number(index);
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      console.error(
        entries.length === 0
          ? 'No cached results yet — run ask/compare/trending first.'
          : `No cached result at index ${index}. Run \`grokscope history\` to list them (1–${entries.length}).`,
      );
      process.exit(1);
    }
    const entry = entries[n - 1]!;
    renderOutput(
      parseResponse(entry.response),
      opts,
      { command: entry.meta.command, query: entry.meta.query, days: entry.meta.days },
      entry.meta.model,
    );
  });

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const cacheCmd = program
  .command('cache')
  .description('inspect or clear the local response cache — free, local only');

cacheCmd
  .command('stats', { isDefault: true })
  .description('entry count, disk usage, and age range of the cache')
  .action(() => {
    const s = cache.stats();
    console.log(`Cache directory: ${s.dir}`);
    console.log(`Entries: ${s.entries}`);
    console.log(`Size: ${formatBytes(s.bytes)}`);
    if (s.oldest && s.newest) {
      console.log(`Range: ${s.oldest.slice(0, 10)} … ${s.newest.slice(0, 10)}`);
    }
    if (s.entries > 0) {
      console.log('\nClear it:  grokscope cache clear    (or:  grokscope cache clear --older-than 48)');
    }
  });

cacheCmd
  .command('clear')
  .description('delete cached results (all of them, or only entries older than --older-than)')
  .option('--older-than <hours>', 'only delete entries older than this many hours')
  .action((opts: { olderThan?: string }) => {
    let olderThanMs: number | undefined;
    if (opts.olderThan !== undefined) {
      const hours = Number(opts.olderThan);
      if (!Number.isFinite(hours) || hours < 0) {
        console.error(
          `Invalid --older-than value: ${opts.olderThan} (expected a non-negative number of hours)`,
        );
        process.exit(1);
      }
      olderThanMs = hours * 3_600_000;
    }
    const removed = cache.clear(olderThanMs);
    console.log(
      removed === 0
        ? 'Nothing to clear — the cache is empty (or has nothing that old).'
        : `Removed ${removed} cached result${removed === 1 ? '' : 's'}.`,
    );
  });

program
  .command('demo')
  .description('replay a recorded real query — see the output with no API key or credits')
  .argument('[which]', `which sample: ${DEMO_NAMES.join(' | ')}`, 'ask')
  .option('--all', 'run all three samples in sequence')
  .option('--json', 'machine-readable JSON output (for CI/scripts)')
  .option('--md', 'clean markdown output (for newsletters/notes)')
  .action((which: string, opts: { all?: boolean; json?: boolean; md?: boolean }) => {
    if (opts.json && opts.md) {
      console.error('--json and --md are mutually exclusive — pick one.');
      process.exit(1);
    }
    const names = opts.all ? [...DEMO_NAMES] : [which];
    for (const n of names) {
      if (!DEMO_NAMES.includes(n as DemoName)) {
        console.error(`Unknown demo "${n}". Choose one of: ${DEMO_NAMES.join(', ')} (or --all).`);
        process.exit(1);
      }
    }
    try {
      for (const n of names) runDemo(n as DemoName, opts, VERSION);
    } catch (err) {
      console.error(
        `Could not load the demo sample: ${err instanceof Error ? err.message : String(err)}\n` +
          'Record fresh samples with:  npm run demo:record',
      );
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
