# Changelog

## 1.5.0 — 2026-09-25

### X Search's per-item cost on the cost line

On 2026-09-21 xAI stopped billing X Search per call ($5 per 1,000 calls) and
started billing per item fetched: $5 per 1,000 posts and $10 per 1,000 user
profiles, on top of tokens
([docs.x.ai/developers/tools/x-search](https://docs.x.ai/developers/tools/x-search)).
Every post a search or thread fetch returns counts, parent and quoted posts
included, and the counts accumulate across all the searches in a request
without de-duplication. So posts fetched, not tool calls, is now the number
that decides what a query costs. The Responses API reports it as
`usage.server_side_tool_usage_details.x_posts_fetched` and `x_users_fetched`,
and 1.4.0 ignored both.

- **Cost line** (stderr) appends the counts and their list-price share of the
  bill: `1,600 tokens · $1.1240 billed · X Search 184 posts, 3 profiles (~$0.95)`.
  The profile clause is left out when no profiles were fetched, and both counts
  at zero print `X Search 0 posts (~$0.00)`. Without `cost_in_usd_ticks` the
  total keeps its `~$… (estimated)` wording and the X Search segment still
  prints, because the token estimate can't see that spend.
- **`--json`**: `usage` gains `xPostsFetched`, `xUsersFetched` and
  `xSearchCostUsd` (8 decimals). They're omitted when the response has no
  counts. Every existing field keeps its value.
- **Parsing** (`GrokResult.usage.xPostsFetched` / `xUsersFetched`): only a
  non-negative integer is accepted. Negative, fractional, string or null counts
  are ignored rather than coerced.
- **Unchanged when the counts are missing.** A proxy, or a result cached
  before the repricing, prints byte-for-byte what 1.4.0 printed. This was
  checked against the published 1.4.0 tarball over 20 command/format/cache
  combinations, including a cache written by 1.4.0 and read by 1.5.0. Cache hits
  and `grokscope history <n>` get the breakdown from the stored raw body with no
  migration.
- **Docs**: the README and code comments no longer describe the per-call
  model. The README's `~$0.15–$0.30 per query` budget is gone, since it was
  measured under the old pricing.
- **Mock**: `test/mock-server.mjs` returns `x_posts_fetched` (default 184) and
  `x_users_fetched` (default 3), overridable with `xPostsFetched` /
  `xUsersFetched` and dropped by `omitFetchCounts` / `MOCK_OMIT_FETCH_COUNTS=1`.
  `omitCostTicks` now drops only the ticks, so the two absences can be tested
  separately. `x_search_calls` is still there.
- **`npm run verify:live`** also checks that a real response puts posts
  fetched on the cost line, since the e2e suite can only prove it against the
  mock.
- **`npm test`** now exists (an alias for `test:e2e`). The release workflow
  already ran it, so a tag push would have failed before publishing.
- e2e grew from 120 to 140 checks, including a `--version` check against
  `package.json`.

## 1.4.0 — 2026-08-06

### Exact billed cost, straight from the API

Every response from xAI's `/v1/responses` carries `usage.cost_in_usd_ticks` —
"the actual amount billed, after all applicable discounts (including prompt
caching reductions) have been applied, and inclusive of all token costs and
server-side tool invocation costs" (1 USD = 10^10 ticks, per
[docs.x.ai/developers/cost-tracking](https://docs.x.ai/developers/cost-tracking)).
GrokScope was parsing the token counts out of that same object and discarding
the exact figure, then reconstructing a cost from a `$2/M in + $6/M out` table.

That estimate is wrong three ways, and the errors go **in both directions** —
recomputed from this repo's own recorded live runs (`demo/*.json`):

| Run | Tokens (in/out) | Exact (`cost_in_usd_ticks`) | Old estimate | Error |
|---|---|---|---|---|
| `demo/ask.json` | 29,320 / 2,280 | **$0.082301** (823008000 ticks) | $0.072320 | **14% low** — the estimate can't see the 6 `x_search` calls ($5/1k, billed separately from tokens) |
| `demo/compare.json` | 48,189 / 2,656 | **$0.119872** (1198724000 ticks) | $0.112314 | **7% low** — same cause, 12 tool calls |
| `demo/trending.json` | 83,391 / 2,402 | **$0.152848** (1528484000 ticks) | $0.181194 | **19% HIGH** — the $0.30/M cached-input discount (51,968 cached tokens) outweighs the tool spend |

The third structural gap: the table hardcodes the sub-200k-token tier, so a
≥200k-token prompt is billed at $4/$12 while the estimate says $2/$6.

Changes:

- **Parse `usage.cost_in_usd_ticks`** (`GrokResult.usage.costUsdTicks` /
  `costUsd`). Only a finite non-negative number is accepted; missing, null,
  string or negative values are never coerced and fall back cleanly.
- **Cost line** (stderr): prints the exact figure without a hedge —
  `70,821 tokens · $0.1975 billed`. When the field is absent (a proxy, an
  older recorded response, the offline mock) it keeps the hedged wording:
  `70,821 tokens · ~$0.1529 (estimated)`.
- **`--json`**: the `usage` block gains `costUsd` (the resolved figure, 8
  decimals — a cheap call can be well under a cent) and `costExact`.
  `estimatedCostUsd` keeps its exact pre-1.4.0 meaning and value, so existing
  consumers don't break.
- **Cache & history**: the exact figure travels with the cached raw body, so a
  cache hit and `grokscope history <n>` now print the identical cost line the
  live run did — including entries cached by older versions, whose live
  responses already contained the field. Pre-ticks entries fall back to the
  estimate with no migration.
- **Unknown `GROK_MODEL` win**: with a model that has no published rate, 1.3.0
  printed no dollar figure at all; the exact field now populates `costUsd`
  regardless of the rate table.
- **Mock/test coverage**: `test/mock-server.mjs` returns `cost_in_usd_ticks`
  (omittable via `omitCostTicks` / `MOCK_OMIT_COST_TICKS=1`, overridable via
  `costTicks`), and the e2e suite grew from 101 to 120 checks — including a
  unit-level pin of the 10^10 conversion (158500 ticks = $0.00001585).

`estimateCostUsd` and the per-model rate table remain as the documented
fallback. The historical caveat that the printed figure was "an estimate from
the published per-model rates, not xAI billing" no longer applies: on direct
xAI calls the printed figure now **is** xAI billing.

## 1.3.0 — 2026-07-23

- `watch` mode: track sentiment + momentum per topic over time, with deltas
  since the last snapshot (`watch add/rm/list/run/log`).
- `release` command (community reaction to a release) and `pain` command
  (ranked pain-point digest).
- Cache management: `cache` stats, `cache clear [--older-than]`, `--max-age`.

## 1.1.0 and earlier

Initial releases: `ask` / `compare` / `trending` on Grok 4.5's server-side
`x_search`, cited terminal output with recency tags, `--json` / `--md`,
response cache + `history`, `doctor`, offline `demo` mode.
