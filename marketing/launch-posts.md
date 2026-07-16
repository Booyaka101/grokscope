# Launch posts â€” ready to paste (open-source edition)

> Attach `screenshot-ask.png` (hero) and `screenshot-trending.png` (follow-up) wherever images are supported.
> Replace `https://github.com/Booyaka101/grokscope` with the repo link (and `https://www.npmjs.com/package/grokscope` with https://www.npmjs.com/package/grokscope) before posting.

---

## X launch thread (post from your account)

**Post 1 (with screenshot-ask.png):**

I got tired of picking my stack from year-old blog posts.

So I built GrokScope â€” a free, open-source CLI that asks Grok 4.5 (with native X search) what developers are saying THIS WEEK. Every claim cited to real posts, clickable in your terminal, with recency tags.

MIT licensed. `npm i -g grokscope` â†’ https://github.com/Booyaka101/grokscope

**Post 2 (reply, with screenshot-trending.png):**

`grokscope trending --topics "rust,typescript,go"` = a weekly state-of-the-ecosystem report in 20 seconds: sentiment, top concern, momentum per topic.

--json for CI jobs, --md for newsletters. Your xAI key, your data â€” no middleman server.

**Post 3 (reply):**

Fun implementation details:
â€¢ citations render as OSC 8 clickable hyperlinks
â€¢ post dates are decoded straight out of X snowflake IDs â†’ "(4d ago)"
â€¢ `grokscope doctor` validates your setup against GET /v1/models for free
â€¢ 31 e2e tests run against a doc-accurate offline mock â€” no key needed to contribute

Stars & PRs welcome: https://github.com/Booyaka101/grokscope

---

## Show HN

**Title:**
Show HN: GrokScope â€“ open-source CLI that asks Grok 4.5 what devs on X think

**Body:**

I kept making stack decisions from stale blog posts and SEO listicles, so I built a small CLI on top of Grok 4.5's native X search tool (shipped July 2026). MIT licensed, BYOK.

Three commands:

- `grokscope ask "bun vs node in 2026"` â€” researches the last 30 days of X posts, cites at least 3 real ones, ends with a "Community Verdict"
- `grokscope compare react solidjs` â€” head-to-head pros/cons from actual posts this week, winner with caveats
- `grokscope trending --topics "rust,typescript,go"` â€” sentiment / top concern / momentum per topic

Details I enjoyed building: citations render as OSC 8 clickable hyperlinks in modern terminals, and each cited post gets a recency tag by decoding the timestamp straight out of its snowflake ID â€” so you see "(4d ago)", not "recently". `--json` gives a stable schema (citation dates, token usage, estimated cost) for CI; `--md` outputs newsletter-ready markdown; piped output falls back to plain text.

It's BYOK â€” your xAI key from console.x.ai (new accounts include $20 credit; a query costs a few cents at $2/$6 per M tokens, and the CLI prints the exact cost after each run). One POST to their /v1/responses endpoint with the x_search tool enabled â€” no scraping, no X API keys. The whole pipeline is testable offline against a doc-accurate mock, so contributing doesn't require a key.

Repo: https://github.com/Booyaka101/grokscope

Happy to answer questions about the Responses API / x_search integration â€” the docs steer you to /v1/responses rather than chat/completions for the agentic tools, which surprised me.

---

## Reddit r/commandline or r/node (secondary, day 2-3)

**Title:** GrokScope: open-source CLI that asks Grok what devs on X actually think about your stack choices

**Body:** Same as Show HN body; lead with the snowflake-ID recency-tag trick and the OSC 8 links â€” those communities respond to terminal craft. Repo link at the end.

---

## After launch

- Pin the repo on your GitHub profile; add topics `grok`, `xai`, `cli`, `developer-tools`, `x-search` for discovery.
- Reply to every issue/PR within 24h for the first two weeks â€” early responsiveness compounds stars.
- When (not if) someone asks "can it track sentiment over time?" â€” that's the validated signal to build the `watch`/history layer, and the natural seed of a paid hosted tier.
