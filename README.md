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

1. **Get an API key** at [console.x.ai](https://console.x.ai), then **add credits to your team** — a brand-new team starts with none, and every call returns `403` until you do. (Grok 4.5 is $2/M input, $6/M output tokens. Budget **~$0.15–$0.30 per query** — `x_search` pulls dozens of real posts into context, so a run measures 70k–140k tokens. GrokScope prints the cost after every run.) If anything is off, `grokscope doctor` tells you which of these it is, for free.
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
| `grokscope doctor` | 10-second setup check: key present, API reachable, key valid, model available — free, spends no tokens | — |
| `grokscope history [index]` | List recently cached results, or re-print one by index — **free, no tokens**. Honours `--json` / `--md` | — |
| `grokscope demo [which]` | Replay a recorded real run (`ask` / `compare` / `trending`, or `--all`) — **no API key or credits**. Honours `--json` / `--md` | — |

**Options (all search commands):**

- `--handles vercel,rauchg` — only consider posts from these X handles (max 20)
- `--exclude someuser` — exclude handles (cannot be combined with `--handles`)
- `--days 14` — override the search window (prompt and search filter stay in sync)
- `--images` / `--videos` — let Grok analyze media inside posts
- `--json` — stable machine-readable output: content, numbered citations with `postedAt`/`recency`, source URLs, token usage with `estimatedCostUsd`. Built for CI jobs and dashboards.
- `--md` — clean markdown with an ISO-dated `## Sources` section. Built for pasting into newsletters and docs (`>> newsletter.md`).
- `--fresh` — bypass the cache and fetch a fresh result (and overwrite the cached copy).
- `--max-age <hours>` — ignore cached results older than this many hours (default `24`).

## Caching & history

Every successful query is cached under `GROKSCOPE_HOME` (default `~/.grokscope`), keyed by a hash of the request (model + prompt + search window). An **identical repeat** — including the same query re-rendered as `--json` or `--md` — is served from disk for free, with a dim `(from cache)` note and no cost line. Use `--fresh` to force a live call, or `--max-age <hours>` to control how stale a hit may be.

```bash
grokscope history        # list recent cached results (index, command, date, query)
grokscope history 1      # re-print entry #1 for free (parse + render, no tokens)
```

`demo` and `doctor` never touch the cache.

**Examples:**

```bash
grokscope ask "is anyone actually using React Server Components in prod?"
grokscope compare react solidjs
grokscope trending --topics "rust,typescript,go"
grokscope ask "htmx in production" --handles htmx_org,intercoolerjs --days 60
grokscope trending --topics "our-sdk" --json > sentiment.json   # nightly CI job
grokscope ask "state of deno" --md >> newsletter.md             # newsletter section
```

Output is markdown-aware: bold headers, inline citations as blue clickable links (OSC 8 — works in Windows Terminal, iTerm2, WezTerm, Ghostty, VS Code), and recency tags decoded from each X post's snowflake ID. Piped output (`| less`, `> file.md`) automatically falls back to plain text with raw URLs.

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `GROK_API_KEY` (or `XAI_API_KEY`) | xAI API key — **required** | — |
| `GROK_MODEL` | model ID | `grok-4.5` |
| `GROK_BASE_URL` | API base (useful for proxies/testing) | `https://api.x.ai/v1` |
| `GROKSCOPE_HOME` | cache directory for `history` / repeat queries | `~/.grokscope` |
| `NO_COLOR` | disable ANSI styling | — |

## How it works

One POST to xAI's `/v1/responses` endpoint with the server-side `x_search` tool enabled ([docs](https://docs.x.ai/developers/tools/x-search)). Grok 4.5 runs the X searches agentically, reasons over the posts, and returns text with inline `url_citation` annotations — GrokScope renders those as numbered clickable sources. No scraping, no X API keys. Transient failures (429/5xx) are retried automatically with backoff, honoring `Retry-After`.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm run test:e2e     # 67 checks against a doc-accurate local mock of /v1/responses
npm run verify:live  # the 3 acceptance queries against the REAL API (needs GROK_API_KEY, ~$0.60)
npm pack             # build the distributable tarball
```

After each query the CLI prints a dim cost line to stderr (`70,821 tokens · ~$0.1520` — a real measured run) so BYOK users always know what they're spending. Note it is an estimate from the published per-model rates ($2/$6-per-M for grok-4.5), not xAI billing; console.x.ai is the source of truth. If you point `GROK_MODEL` at a model with no published rate here, the token count still prints but the dollar figure is omitted rather than guessed. Shipping checklist lives in `SHIP.md`.

`test/mock-server.mjs` mimics the xAI Responses API (including request-schema validation and realistic snowflake post IDs), so the full CLI pipeline is testable offline: `node test/mock-server.mjs` starts it standalone for manual demos.

## Contributing

Issues and PRs welcome. The whole pipeline is testable offline (`npm run test:e2e` — 67 checks against a doc-accurate mock of xAI's `/v1/responses`), so you don't need an API key to hack on it. Good first contributions: new command modes (release-reaction reports, pain-point digests), output formats, or a `watch` mode with stored history.

## License

[MIT](LICENSE). Bring your own xAI key. Not affiliated with xAI or X Corp.
