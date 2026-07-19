/**
 * `grokscope demo` — replay a recorded real query so anyone can see the output
 * with no API key and no credits spent.
 *
 * The recorded file is the exact raw `/v1/responses` body, run through the same
 * `parseResponse` + formatter as a live run — so the demo is a faithful sample,
 * not a mock-up. Fixtures live in `demo/<name>.json` (shipped via package.json
 * "files") and are recorded with `npm run demo:record` (scripts/record-demo.mjs).
 *
 * GROKSCOPE_DEMO_DIR overrides the fixture directory (used by the test suite).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResponse } from './grok.js';
import { renderResult, renderMarkdownDoc, renderJson } from './formatter.js';

export const DEMO_NAMES = ['ask', 'compare', 'trending'] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

interface DemoFixture {
  meta: {
    command: string;
    query: string;
    days: number;
    recordedAt: string;
    model: string;
    runLive: string;
  };
  response: Record<string, unknown>;
}

interface DemoOpts {
  json?: boolean;
  md?: boolean;
}

function demoDir(): string {
  return (
    process.env.GROKSCOPE_DEMO_DIR ??
    fileURLToPath(new URL('../demo/', import.meta.url))
  );
}

export function loadDemo(name: string): DemoFixture {
  const file = path.join(demoDir(), `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as DemoFixture;
}

const ESC = '\x1b';
const dim = (s: string): string =>
  process.stderr.isTTY && !process.env.NO_COLOR ? `${ESC}[2m${s}${ESC}[22m` : s;

/** Render one recorded demo through the real parse + format path. */
export function runDemo(name: DemoName, opts: DemoOpts, version: string): void {
  const { meta, response } = loadDemo(name);
  const result = parseResponse(response);

  // Banner goes to stderr so `grokscope demo ask > out.md` captures only the
  // result — exactly like a live run.
  process.stderr.write(
    dim(
      `● grokscope demo — recorded sample. No API key, no credits, no network.\n` +
        `  ${meta.command} "${meta.query}"  ·  recorded ${meta.recordedAt}  ·  ${meta.model}\n` +
        `  Run it live:  ${meta.runLive}\n\n`,
    ),
  );

  if (opts.json) {
    process.stdout.write(
      renderJson(result, {
        command: meta.command,
        query: meta.query,
        model: meta.model,
        searchWindowDays: meta.days,
        version,
      }),
    );
    return;
  }
  process.stdout.write(opts.md ? renderMarkdownDoc(result) : renderResult(result));
}
