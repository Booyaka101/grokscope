# GrokScope 🔭

[![CI](https://github.com/Booyaka101/grokscope/actions/workflows/ci.yml/badge.svg)](https://github.com/Booyaka101/grokscope/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/grokscope)](https://www.npmjs.com/package/grokscope)
[![license](https://img.shields.io/npm/l/grokscope)](./LICENSE)

**Real-time developer community intelligence from X — in your terminal.**

GrokScope is a Node.js CLI built on **Grok 4.5** (xAI, released July 8 2026) and its native **X search tool**. Instead of googling stale blog posts, ask what developers are *actually saying on X right now* — with every claim cited back to real posts, rendered as clickable terminal links with recency tags.

```
$ grokscope ask "bun vs node in 2026"

What developers are saying
Bun's 1.3 release thread drew heavy praise for install speed and built-in
bundling [1]. Node maintainers pushed back with 22.x perf numbers closing
the gap [2]. Several production users report sticking with Node for
ecosystem stability while using Bun for scripts and CI [3] ...

Community Verdict: the community leans Node for production workloads in
2026, with Bun the clear favorite for local tooling and new small services.

Sources
  1. https://x.com/.../status/20761214... (4d ago)
  2. https://x.com/.../status/20743094... (9d ago)
  3. https://x.com/.../status/20721351... (15d ago)
```

## Try it first — no key, no credits

See exactly what GrokScope produces before you sign up for anything:

```bash
npx grokscope demo          # replays a real recorded `ask "bun vs node in 2026"`
npx grokscope demo --all    # ask + compare + trending
```

`demo` replays a **real recorded run** through the same renderer as a live query — clickable citations, recency tags, the lot — with no API key, no credits, and no network. When the output looks useful, set a key (below) and run it live.

## Setup (2 minutes)

1. **Get an API key** at [console.x.ai](https://console.x.ai), then **add credits to your team** — a brand-new team starts with none, and every call returns `403` until you do. (Grok 4.5 is $2/M input, $6/M output tokens, and since 2026-09-21 X Search adds $5 per 1,000 posts and $10 per 1,000 user profiles it fetches. GrokScope prints the **exact billed cost** after every run, straight from the API's own `cost_in_usd_ticks` field, along with how many posts X Search fetched.) If anything is off, `grokscope doctor` tells you which of these it is, for free.
2. **Set the key** (GrokScope also accepts the standard `XAI_API_KEY`):
   ```powershell
   # PowerShell
   $env:GROK_API_KEY = 'xai-...'
   # bash/zsh
   export GROK_API_KEY=xai-...
   ```
3. **Install:**
   ```bash
   npm install -g grokscope          # from npm
   # or from a clone:
   npm install && npm run build && npm install -g .
   ```
4. **Check your setup:** `grokscope doctor` — verifies key, connectivity, and model availability in ~1 second, without spending tokens.

## Commands

| Command | What it does | Window |
|---|---|---|
| `grokscope ask <question>` | Researches your question from live X posts; cites ≥3 real posts and ends with a **Community Verdict** | last 30 days |
| `grokscope compare <techA> <techB>` | Head-to-head community sentiment with pros/cons per side, cited, plus a winner with caveats | this week |
| `grokscope trending --topics "rust,typescript,go"` | Per-topic buzz report: sentiment, top concern, momentum (rising/falling/stable) | this week |
| `grokscope release <project> [version]` | Community reaction to a release: praise, breakage, migration pain — ends with an **Upgrade Verdict** | last 14 days |
| `grokscope pain <tech>` | Ranked digest of the pain points developers actually report, with workarounds — ends with a **Biggest Pain** line | last 30 days |
| `grokscope watch run` | Snapshot sentiment + momentum for every watched topic and show **what moved** since the last run | this week |
| `grokscope watch add/rm/list/log` | Manage the watched-topic list and print the stored snapshot timeline — **free, no tokens** | — |
| `grokscope doctor` | 10-second setup check: key present, API reachable, key valid, model available — free, spends no tokens | — |
| `grokscope history [index]` | List recently cached results, or re-print one by index — **free, no tokens**. Honours `--json` / `--md` | — |
| `grokscope cache [clear]` | Cache stats, or clear it (`--older-than <hours>` to prune) — **free, no tokens** | — |
| `grokscope demo [which]` | Replay a recorded real run (`ask` / `compare` / `trending`, or `--all`) — **no API key or credits**. Honours `--json` / `--md` | — |

**Options (all search commands):**

- `--handles vercel,rauchg` — only consider posts from these X handles (max 20)
- `--exclude someuser` — exclude handles (cannot be combined with `--handles`)
- `--days 14` — override the search window (prompt and search filter stay in sync)
- `--images` / `--videos` — let Grok analyze media inside posts
- `--json` — stable machine-readable output: content, numbered citations with `postedAt`/`recency`, source URLs, and token usage with `costUsd` + `costExact` (`costExact: true` means `costUsd` is xAI's exact billed amount from `cost_in_usd_ticks` — X Search and cache discounts included; `false` means it's the token-rate estimate). `estimatedCostUsd` keeps its pre-1.4.0 meaning for existing consumers. When the API reports how many posts X Search fetched, `usage` also carries `xPostsFetched`, `xUsersFetched` and `xSearchCostUsd` (their cost at list price, which is inside `costUsd` when `costExact` is true and missing from the token estimate when it's false); all three are absent otherwise, and `xUsersFetched` alone is left out if the profile count is malformed. Built for CI jobs and dashboards.
- `--md` — clean markdown with an ISO-dated `## Sources` section. Built for pasting into newsletters and docs (`>> newsletter.md`).
- `--fresh` — bypass the cache and fetch a fresh result (and overwrite the cached copy).
- `--max-age <hours>` — ignore cached results older than this many hours (default `24`).

## Caching & history

Every successful query is cached under `GROKSCOPE_HOME` (default `~/.grokscope`), keyed by a hash of the request (model + prompt + search window). An **identical repeat** — including the same query re-rendered as `--json` or `--md` — is served from disk for free, with a dim `(from cache)` note; it re-prints the original run's cost line (the exact billed figure travels with the cached response). Use `--fresh` to force a live call, or `--max-age <hours>` to control how stale a hit may be.

```bash
grokscope history        # list recent cached results (index, command, date, cost, query)
grokscope history 1      # re-print entry #1 for free (parse + render, no tokens)
```

`demo` and `doctor` never touch the cache. `grokscope cache` shows entry count and disk usage; `grokscope cache clear [--older-than <hours>]` prunes it.

## Tracking sentiment over time (watch)

`trending` answers *"what's the buzz right now?"* — `watch` answers *"what changed?"*

```bash
grokscope watch add rust typescript   # pick your topics (stored locally)
grokscope watch run                   # snapshot: ONE query across all topics
# ...days later...
grokscope watch run                   # new snapshot + what moved
```

After the report, GrokScope diffs the snapshot against the previous one:

```
Changes since 2026-07-16
  rust        sentiment negative -> positive   momentum stable -> rising
  typescript  no change (mixed, stable)
```

Each `watch run` is a single live query over all watched topics (same cost as one `trending`), and every snapshot is appended to `GROKSCOPE_HOME/watch-history.jsonl`. `watch log [topic]` prints the stored timeline for free. With `--json`, `watch run` adds a `watch` block — per-topic `sentiment`, `momentum`, `prevSentiment`, `prevMomentum`, `changed` — built for nightly CI jobs that alert on sentiment flips.

**Examples:**

```bash
grokscope ask "is anyone actually using React Server Components in prod?"
grokscope compare react solidjs
grokscope trending --topics "rust,typescript,go"
grokscope release nextjs 15                      # who upgraded, what broke, upgrade verdict
grokscope pain webpack                           # ranked pain points, with workarounds
grokscope ask "htmx in production" --handles htmx_org,intercoolerjs --days 60
grokscope trending --topics "our-sdk" --json > sentiment.json   # nightly CI job
grokscope watch run --json > snapshot.json                      # sentiment-flip alerts
grokscope ask "state of deno" --md >> newsletter.md             # newsletter section
```

Output is markdown-aware: bold headers, inline citations as blue clickable links (OSC 8 — works in Windows Terminal, iTerm2, WezTerm, Ghostty, VS Code), and recency tags decoded from each X post's snowflake ID. Piped output (`| less`, `> file.md`) automatically falls back to plain text with raw URLs.

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `GROK_API_KEY` (or `XAI_API_KEY`) | xAI API key — **required** | — |
| `GROK_MODEL` | model ID | `grok-4.5` |
| `GROK_BASE_URL` | API base (useful for proxies/testing) | `https://api.x.ai/v1` |
| `GROKSCOPE_HOME` | local state: cache, `history`, watch list + snapshots | `~/.grokscope` |
| `NO_COLOR` | disable ANSI styling | — |

## How it works

One POST to xAI's `/v1/responses` endpoint with the server-side `x_search` tool enabled ([docs](https://docs.x.ai/developers/tools/x-search)). Grok 4.5 runs the X searches agentically, reasons over the posts, and returns text with inline `url_citation` annotations — GrokScope renders those as numbered clickable sources. No scraping, no X API keys. Transient failures (429/5xx) are retried automatically with backoff, honoring `Retry-After`.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm run test:e2e     # 148 checks against a doc-accurate local mock of /v1/responses
npm run verify:live  # the 3 acceptance queries against the REAL API (needs GROK_API_KEY, spends real credits)
npm pack             # build the distributable tarball
```

After each query the CLI prints a dim cost line to stderr so BYOK users always know what they're spending. When the API returns `usage.cost_in_usd_ticks` (direct xAI calls do), the figure is **exact** — xAI's actual billed amount, inclusive of X Search and prompt-caching discounts — and prints without a hedge: `70,821 tokens · $0.1975 billed`. If the field is missing (a proxy, an older recorded response, the mock with `MOCK_OMIT_COST_TICKS=1`), the line falls back to the published per-model token rates and says so: `70,821 tokens · ~$0.1529 (estimated)`; with a `GROK_MODEL` that has no published rate *and* no ticks, the token count still prints but the dollar figure is omitted rather than guessed. Cache hits and `grokscope history <n>` re-print the original run's figure.

Since 2026-09-21 xAI bills X Search per item fetched, not per call: $5 per 1,000 posts and $10 per 1,000 user profiles, on top of tokens ([pricing](https://docs.x.ai/developers/tools/x-search)). Every post a search or thread fetch returns counts, parents and quoted posts included, and the counts add up across all the searches in one request without de-duplication. When the response reports them (`usage.server_side_tool_usage_details.x_posts_fetched` and `x_users_fetched`), the cost line adds them with their cost at list price, rounded to the cent. That figure is part of the billed total, not an extra charge. Against the offline mock:

```
1,600 tokens · $1.1240 billed · X Search 184 posts, 3 profiles (~$0.95)
```

The profile clause is dropped when no profiles were fetched, and the figure is dropped if it comes out above the exact bill (a discount or credit it can't see). Without `cost_in_usd_ticks` the total is a token estimate that leaves X Search out, and the X Search figure comes on top of it. Responses without the counts (a proxy, results cached before the repricing) print exactly the 1.4.0 line. Shipping checklist lives in `SHIP.md`.

`test/mock-server.mjs` mimics the xAI Responses API (including request-schema validation and realistic snowflake post IDs), so the full CLI pipeline is testable offline: `node test/mock-server.mjs` starts it standalone for manual demos and prints the line above.

## Contributing

Issues and PRs welcome. The whole pipeline is testable offline (`npm run test:e2e` — 148 checks against a doc-accurate mock of xAI's `/v1/responses`), so you don't need an API key to hack on it. Good first contributions: new command modes (e.g. a `quotes` mode that surfaces the most-shared verbatim takes), output formats, shell completions, or a scheduled `watch run` recipe for GitHub Actions.

## License

[MIT](LICENSE). Bring your own xAI key. Not affiliated with xAI or X Corp.
