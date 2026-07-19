# Demo fixtures

These JSON files are **real recorded `grokscope` runs** — the exact raw
`/v1/responses` body from the xAI API for each canonical query. `grokscope demo`
replays them through the same parser and formatter as a live run, so anyone can
see the output with **no API key and no credits**.

- `ask.json` — `grokscope ask "bun vs node in 2026"`
- `compare.json` — `grokscope compare react solidjs`
- `trending.json` — `grokscope trending --topics "rust,typescript,go"`

## Re-recording

Refresh them anytime against the live API (needs `GROK_API_KEY`, ~$0.60):

```bash
GROK_API_KEY=xai-...  npm run demo:record
```

The request bodies in `scripts/record-demo.mjs` mirror exactly what the CLI
sends for each command, so the samples stay faithful.
