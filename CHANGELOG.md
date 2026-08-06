# Changelog

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
