# SHIP.md — open-source launch checklist

Model: **free & open source (MIT), BYOK.** Money comes later via reach — GitHub Sponsors,
and a paid `watch`/history tier once demand shows up. Tonight is about maximum distribution.

## 1. Get the xAI key + live verification (5 min)

1. Sign in at https://console.x.ai → create an API key, **and buy credits for the team**.
   A new team has zero credits and every call 403s until you do (confirmed 2026-07-16 —
   there was no automatic free credit). `grokscope doctor` names this exact cause for free.
2. In PowerShell, in this folder:
   ```powershell
   $env:GROK_API_KEY = 'xai-...'
   npm run verify:live
   ```
   Runs `doctor` first (free), then the three real acceptance queries (~$0.60 measured
   2026-07-16: $0.159 + $0.292 + $0.163). All checks must PASS.
   If anything fails, bring the output to Claude — it gets fixed from the error text before launch.

## 2. Real screenshots (10 min, strongly recommended for OSS credibility)

Run in Windows Terminal and screenshot the real output:
```powershell
node dist/cli.js ask "bun vs node in 2026"
node dist/cli.js trending --topics "rust,typescript,go"
```
Replace `marketing/screenshot-ask.png` / `screenshot-trending.png`. Real output with real
post URLs beats the mocked examples — HN will click the citations.

## 3. GitHub repo — ✅ DONE (live at https://github.com/Booyaka101/grokscope)

Repo created, pushed, description + topics set, package.json has repository metadata.

Two leftovers that need your GitHub account in a browser:
- **CI workflow:** the gh token lacked `workflow` scope, so `.github/workflows/ci.yml` is committed locally-excluded. Run `gh auth refresh -h github.com -s workflow` (10 s, browser approve), then tell Claude — it pushes the workflow and the green 3-OS badge appears.
- **Social preview image** (Settings → General → Social preview): upload `marketing/screenshot-ask.png`. Optional: enable Sponsors.

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
