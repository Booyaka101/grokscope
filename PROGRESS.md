# PROGRESS — grokscope

## Current state: v1.4.0 BUILT & VERIFIED locally (commit 7a3869a on main, NOT pushed)

v1.4.0 replaces the token-rate cost *estimate* with xAI's exact billed figure
from `usage.cost_in_usd_ticks` (1 USD = 10^10 ticks, inclusive of x_search
tool spend and prompt-caching discounts, per docs.x.ai/developers/cost-tracking).
The estimate (`estimateCostUsd` / `MODEL_RATES`) remains the documented
fallback for proxies, ticks-less responses and the offline mock.

### VERIFIED working (all offline, no key needed)

- `npm run test:e2e` → **120/120** (was 101; +19 new checks incl. a unit pin of
  the 10^10 conversion: 158500 ticks = $0.00001585).
- `tsc --noEmit` clean.
- Live-vs-cache parity: same query live then from cache prints the identical
  `1,600 tokens · $0.0061 billed` line; `history 1` too (manual run, mock API).
- `demo ask --json` (REAL recorded xAI body): costUsd 0.0823008 exact vs
  estimatedCostUsd 0.07232 — the 14%-low case, from shipped data.
- Unknown `GROK_MODEL` + ticks → numeric costUsd (1.3.0 printed no dollar).
- `npm pack` → clean-path install in tmp-install/ → smoke PASS; tarball
  includes CHANGELOG.md.
- README updated (Development cost paragraph, --json bullet, cache section,
  120-check counts); acceptance grep: "not xAI billing" only in the historical
  CHANGELOG note.

### Next steps (owner, from phone)

1. `git push` (CI should stay green — no workflow changes).
2. `npm publish` (prepack builds; version already 1.4.0).
3. Optional: `npm run verify:live` with a funded key — it now asserts the
   `$… billed` line appears on a real call (~$0.60 for 3 queries).
4. Then the previously-queued ideas: nightly `watch run --json` Actions recipe,
   replies into live threads.

### Notes for future sessions

- The cache stores the WHOLE raw response body, so ticks persist automatically;
  no cache-format migration was needed (cache.ts docs explain this).
- test/mock-server.mjs: `opts.costTicks` (0 and non-numbers are valid probes),
  `opts.omitCostTicks` / `MOCK_OMIT_COST_TICKS=1`, `opts.expectModel`.
- LESSONS reminder that bit again this build: spawnSync + in-process mock
  server deadlocks — always async spawn (test/e2e.mjs pattern).
