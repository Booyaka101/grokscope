# v1.4.0 announce posts

> **POSTED 2026-08-06:**
> - X (single long-form post, Premium): https://x.com/KillKenny101/status/2085374852870049978
> - dev.to: https://dev.to/booyaka101/your-llm-clis-cost-estimate-is-wrong-in-both-directions-heres-the-field-that-fixes-it-3eg8
>
> Release: https://github.com/Booyaka101/grokscope/releases/tag/v1.4.0 · npm: https://www.npmjs.com/package/grokscope
> The hook is **not** "we added a field". It's "the cost number every BYOK CLI prints is wrong, and here are three measured runs proving it's wrong in both directions."

---

## X — WHAT WAS POSTED (single long-form post, 1394 chars)

Owner has Premium, so the three-post thread below was merged into one post with real
paragraph breaks — which insert verbatim via one atomic `Input.insertText`.

GrokScope v1.4.0 is out, and it exists because of a number I had been getting wrong.

Like most bring-your-own-key CLIs, it estimated each query's cost from token counts and published per-model rates. I finally checked that estimate against what xAI actually billed on three recorded runs. It was wrong every time, and not in a consistent direction: 14% low, 7% low, and 19% HIGH.

Two causes pulling opposite ways. x_search is billed separately at $5 per 1,000 calls and a single query makes 6 to 12 of them, which token math cannot see, so the estimate reads low. But cached input bills at $0.30/M instead of $2/M, and on a cache-heavy run that discount is larger than the tool spend, so the same formula reads high. There is also a pricing tier cliff at 200k prompt tokens that one hardcoded rate pair cannot express.

The fix was sitting in the response body the whole time. xAI returns usage.cost_in_usd_ticks: the actual amount billed, after prompt-caching discounts, inclusive of server-side tool calls, at 1 USD = 10^10 ticks. I had been parsing input_tokens out of that same object and discarding the exact figure sitting next to it.

v1.4.0 prints the real number after every query: 70,821 tokens - $0.1975 billed. The old estimate stays as a labelled fallback for proxies and cached responses. MIT, BYOK, 120 offline tests.

npm i -g grokscope
https://github.com/Booyaka101/grokscope

---

## X — original 3-post thread draft (superseded, kept for reuse)

*(407 chars, plain ASCII, single paragraph — safe for the DraftJS composer)*

Shipped GrokScope v1.4.0. It used to estimate your query cost from token counts and published rates, like most BYOK CLIs do. I checked that estimate against xAI's actual billed figure on three recorded runs and it was wrong every time, in BOTH directions: 14% low, 7% low, and 19% HIGH. It now reports the exact billed amount straight from the API. npm i -g grokscope https://github.com/Booyaka101/grokscope

**Reply (post 2) — the mechanism, 355 chars:**

Why token math can't get there: x_search is billed separately at $5 per 1,000 calls, and one query makes 6-12 of them, so the estimate reads LOW. But cached input bills at $0.30/M instead of $2/M, and on a cache-heavy run that discount is bigger than the tool spend, so the same formula reads HIGH. Two errors, opposite signs, neither visible from tokens.

**Reply (post 3) — the fix, 334 chars:**

The fix was already in the response body. xAI returns usage.cost_in_usd_ticks: the actual amount billed, after prompt-caching discounts, inclusive of server-side tool calls. 1 USD = 10^10 ticks. We were parsing input_tokens out of that same object and throwing the exact number away. Now the CLI prints "$0.1975 billed" with no tilde.

---

## dev.to article

**Title:** Your LLM CLI's cost estimate is wrong in both directions — here's the field that fixes it

**Tags:** `ai`, `opensource`, `cli`, `typescript`

**Body:**

Most BYOK CLIs print a cost line after each call. Nearly all of them compute it the same way: `input_tokens * $in + output_tokens * $out`, from a hardcoded rate table. Mine did too. That number is wrong, and it took measuring three real runs to see how wrong.

I recomputed against xAI's own billed figure on three recorded GrokScope runs:

| Run | Tokens (in/out) | Actually billed | Token-math estimate | Error |
|---|---|---|---|---|
| `ask` | 29,320 / 2,280 | **$0.082301** | $0.072320 | 14% **low** |
| `compare` | 48,189 / 2,656 | **$0.119872** | $0.112314 | 7% low |
| `trending` | 83,391 / 2,402 | **$0.152848** | $0.181194 | 19% **HIGH** |

Three failure modes, and the interesting part is that they don't all push the same way:

1. **Server-side tools are billed separately from tokens.** Grok's `x_search` costs $5 per 1,000 calls; a single GrokScope query makes 6-12 of them. Token math can't see that spend at all, so it under-reports.
2. **Cached input is 85% cheaper.** grok-4.5 bills cached input at $0.30/M against $2.00/M cold. The `trending` run had 51,968 cached tokens — that discount was *larger* than its tool spend, so the same formula over-reported by 19%.
3. **There's a tier cliff.** grok-4.5 is $2/$6 per M under 200k prompt tokens and $4/$12 at or above. One hardcoded pair can't express that, so a long-context call silently reports half its real price.

Errors 1 and 2 point in opposite directions, which is what makes this nasty: you can't correct for it with a fudge factor, and on any given run you don't know which way you're wrong.

The fix was sitting in the response the whole time. xAI's Responses API returns `usage.cost_in_usd_ticks` alongside the token counts — documented as "the actual amount billed, after all applicable discounts (including prompt caching reductions) have been applied, and inclusive of all token costs and server-side tool invocation costs." 1 USD = 10^10 ticks.

```js
// we were doing this...
const usage = { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens };
// ...while raw.cost_in_usd_ticks sat right there in the same object
```

GrokScope v1.4.0 prefers it everywhere:

```
$ grokscope ask "bun vs node in 2026"
...
70,821 tokens · $0.1975 billed        # exact — no tilde, no hedge
```

Three implementation notes that might save you an afternoon:

- **Don't drop the estimate.** Proxies, older cached responses and offline mocks won't have the field. Keep the rate table as a labelled fallback and mark which one you printed — GrokScope's `--json` emits `costUsd` plus `costExact: true|false`.
- **Round to 8 decimals, not 6.** The docs' own example is 158,500 ticks = $0.00001585. At 6 decimals a cheap call rounds to zero.
- **Validate hard, coerce never.** Accept only a finite non-negative number. A `null`, a string, or a negative must fall back cleanly — `Number(null)` is `0`, and a $0.00 cost line that's actually a parse failure is worse than no cost line.

Nice side effect: if you point the CLI at a model with no entry in the rate table, the old code printed no dollar figure at all. The exact field doesn't care what the model is, so it prints one now.

MIT, BYOK, and the whole pipeline runs offline against a doc-accurate mock — 120 e2e checks, no API key needed to contribute.

https://github.com/Booyaka101/grokscope

---

## Reddit — r/commandline (day 2)

**Title:** I compared my CLI's cost estimate to what the API actually billed. It was off by up to 19% — in both directions.

**Body:** Lead with the three-run table, then the two-opposing-errors explanation, then the fix. Same body as the dev.to article, trimmed of the code blocks. Repo link at the end, not the top.

> Note: the alt account is at 1 karma and old-reddit `/submit` throws a reCAPTCHA. Post from new-reddit, and check the sub's full rule list first — r/selfhosted-style "new project megathread" rules bite silently.

---

## Hacker News

Skip a fresh Show HN — v1.4.0 is an upgrade, not a launch, and the account is at 3 karma (submissions currently bounce with "You're posting too fast"). Better use of this material: it's a strong *comment* on any thread about LLM API costs or agent token budgets.

---

## What NOT to say

- ~~"The estimate was too low, so you've been underpaying"~~ — false. One of the three runs over-reported by 19%. The story is that it's wrong in both directions and you can't tell which without the API's own number.
- Don't claim it's exact when the field is missing. `costExact: false` exists for that.
