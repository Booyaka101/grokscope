# SHIP.md — open-source launch checklist

Model: **free & open source (MIT), BYOK.** Money comes later via reach — GitHub Sponsors,
and a paid `watch`/history tier once demand shows up. Tonight is about maximum distribution.

## 1. Get the xAI key + live verification (5 min)

1. Sign in at https://console.x.ai (new accounts include $20 free credit) → create an API key.
2. In PowerShell, in this folder:
   ```powershell
   $env:GROK_API_KEY = 'xai-...'
   npm run verify:live
   ```
   Runs `doctor` first (free), then the three real acceptance queries (~$0.05). All checks must PASS.
   If anything fails, bring the output to Claude — it gets fixed from the error text before launch.

## 2. Real screenshots (10 min, strongly recommended for OSS credibility)

Run in Windows Terminal and screenshot the real output:
```powershell
node dist/cli.js ask "bun vs node in 2026"
node dist/cli.js trending --topics "rust,typescript,go"
```
Replace `marketing/screenshot-ask.png` / `screenshot-trending.png`. Real output with real
post URLs beats the mocked examples — HN will click the citations.

## 3. GitHub repo (10 min)

```powershell
git init; git add -A; git commit -m "GrokScope v1.0.0 — open-source Grok 4.5 x_search CLI"
gh repo create grokscope --public --source . --push    # or create on github.com and push
```
Then on the repo page:
- Description: "Real-time developer community intelligence from X, powered by Grok 4.5's native x_search — cited, clickable, in your terminal."
- Topics: `grok`, `xai`, `cli`, `developer-tools`, `x-search`, `typescript`
- Social preview image: `marketing/screenshot-ask.png`
- Add `repository`, `homepage`, and `bugs` fields to package.json with the repo URL (one-line edit; do it before npm publish).
- Optional: enable GitHub Sponsors (Settings → Features) — costs nothing, captures goodwill.

CI (`.github/workflows/ci.yml`) runs the 31 offline checks on Linux/Windows/macOS on every push — green checkmark on the repo from day one.

## 4. npm publish (5 min)

```powershell
npm login          # needs an npm account (free)
npm publish        # name "grokscope" must be free — if taken: @yourhandle/grokscope
```
`npm i -g grokscope` in the launch posts only works after this step.

## 5. Launch (15 min)

1. Open `marketing/launch-posts.md`, replace `GITHUB_URL` (and NPM_URL) everywhere.
2. X thread (3 posts, screenshots attached) — post mid-morning US time.
3. Show HN — stay around 2-3 h to answer comments (the /v1/responses-vs-chat/completions detail and the snowflake recency trick are good comment fodder).
4. Day 2-3: the Reddit variant (r/commandline, r/node).

## 6. After launch

- Respond to every issue/PR within 24h for two weeks — early responsiveness compounds stars.
- Watch for the "can it track sentiment over time?" ask — that's the validated demand signal
  for the `watch`/history layer, the natural seed of a paid hosted tier (open core).
- Version bumps: edit `version` in package.json + VERSION in src/cli.ts → `npm publish`.

## State of verification (2026-07-16)

| Check | Status |
|---|---|
| Offline e2e (31 checks, doc-accurate mock incl. wire schema, retries, doctor, json/md) | ✅ pass |
| `npm pack` clean tarball + install + bin shim smoke | ✅ pass |
| CI workflow (3 OSes) | ⬜ goes green on first push |
| **Live API (`npm run verify:live`)** | ⬜ needs your key — step 1 |
