/**
 * Terminal output rendering: bold headers, OSC 8 hyperlinks for cited X
 * posts, and recency tags derived from X post snowflake IDs.
 *
 * When stdout is not a TTY (piped output) or NO_COLOR is set, falls back to
 * plain text with raw URLs so output stays grep-able.
 */

import type { Citation, GrokResult } from './grok.js';

const ansiEnabled = (): boolean =>
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const ESC = '\x1b';
const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
const blue = (s: string) => `${ESC}[34m${s}${ESC}[39m`;
const underline = (s: string) => `${ESC}[4m${s}${ESC}[24m`;

/** OSC 8 clickable hyperlink. */
const osc8 = (url: string, label: string) =>
  `${ESC}]8;;${url}${ESC}\\${label}${ESC}]8;;${ESC}\\`;

/** Blue clickable link when ANSI is on; plain "label (url)" otherwise. */
function link(url: string, label: string, ansi: boolean): string {
  if (!ansi) return label === url ? url : `${label} (${url})`;
  return blue(underline(osc8(url, label)));
}

// X/Twitter snowflake IDs encode a millisecond timestamp:
//   ms = (id >> 22) + 1288834974657
// Anchored to the scheme + host so lookalikes (e.g. fx.com/…/status/…) don't match;
// an optional subdomain still allows mobile.twitter.com and the like.
const X_STATUS_RE =
  /https?:\/\/(?:[\w-]+\.)*(?:x|twitter)\.com\/[^/\s]+\/status(?:es)?\/(\d{15,20})/;
const X_EPOCH_MS = 1288834974657n;

/** Extract the post date from an x.com/twitter.com status URL, if any. */
export function xPostDate(url: string): Date | undefined {
  const m = X_STATUS_RE.exec(url);
  if (!m?.[1]) return undefined;
  try {
    const ms = (BigInt(m[1]) >> 22n) + X_EPOCH_MS;
    const date = new Date(Number(ms));
    // Sanity window: 2010 (snowflake launch) .. now + 1 day
    if (date.getTime() < 1288834974657 || date.getTime() > Date.now() + 86_400_000) {
      return undefined;
    }
    return date;
  } catch {
    return undefined;
  }
}

/** Human recency tag: "today", "3d ago", "2mo ago". */
export function recencyTag(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const INLINE_CITATION_RE = /\[\[(\d+)\]\]\((https?:\/\/[^)\s]+)\)/g;
const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * Rewrite each inline `[[N]](url)` so its number matches the deduped Sources
 * list (which is numbered by first-appearance). The model's literal N can drift
 * from that order; the URL is the source of truth, so we renumber by URL.
 */
export function renumberInlineCitations(content: string, citations: Citation[]): string {
  const indexByUrl = new Map(citations.map((c, i) => [c.url, i + 1]));
  return content.replace(INLINE_CITATION_RE, (match, _n: string, url: string) => {
    const idx = indexByUrl.get(url);
    return idx === undefined ? match : `[[${idx}]](${url})`;
  });
}

/** Render Grok's markdown-ish output for the terminal. */
export function renderContent(content: string, ansi = ansiEnabled()): string {
  const lines = content.split('\n').map((line) => {
    // Headers -> bold (underlined when ANSI available)
    const header = /^(#{1,4})\s+(.*)$/.exec(line);
    if (header?.[2] !== undefined) {
      return ansi ? bold(underline(header[2])) : header[2].toUpperCase();
    }
    let out = line;
    // Inline citations [[N]](url) -> clickable [N]
    out = out.replace(INLINE_CITATION_RE, (_m, n: string, url: string) =>
      ansi ? link(url, `[${n}]`, true) : `[${n}] (${url})`,
    );
    // Remaining markdown links
    out = out.replace(MD_LINK_RE, (_m, label: string, url: string) =>
      link(url, label, ansi),
    );
    // **bold**
    out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) =>
      ansi ? bold(inner) : inner,
    );
    return out;
  });
  return lines.join('\n');
}

/** Render the numbered Sources section with links + recency tags. */
export function renderCitations(citations: Citation[], ansi = ansiEnabled()): string {
  if (citations.length === 0) return '';
  const head = ansi ? bold(underline('Sources')) : 'SOURCES';
  const rows = citations.map((c, i) => {
    const date = xPostDate(c.url);
    const tag = date ? ` ${ansi ? dim(`(${recencyTag(date)})`) : `(${recencyTag(date)})`}` : '';
    return `  ${i + 1}. ${link(c.url, c.url, ansi)}${tag}`;
  });
  return `\n${head}\n${rows.join('\n')}`;
}

/** Full render of a Grok result: body + sources. */
export function renderResult(result: GrokResult, ansi = ansiEnabled()): string {
  const content = renumberInlineCitations(result.content, result.citations);
  return `${renderContent(content, ansi).trimEnd()}\n${renderCitations(result.citations, ansi)}\n`;
}

/** --md: clean markdown document (for newsletters, notes, docs). */
export function renderMarkdownDoc(result: GrokResult): string {
  const content = renumberInlineCitations(result.content, result.citations);
  const sources = result.citations.map((c, i) => {
    const date = xPostDate(c.url);
    const tag = date ? ` — ${date.toISOString().slice(0, 10)} (${recencyTag(date)})` : '';
    return `${i + 1}. ${c.url}${tag}`;
  });
  const sourcesBlock = sources.length ? `\n\n## Sources\n\n${sources.join('\n')}` : '';
  return `${content.trimEnd()}${sourcesBlock}\n`;
}

// Published per-million-token rates ($ in, $ out) keyed by model id. GROK_MODEL
// is overridable, so an unknown model yields no cost figure rather than a wrong
// one billed at grok-4.5's rates. console.x.ai billing is always the truth.
const MODEL_RATES: Record<string, [number, number]> = {
  'grok-4.5': [2, 6],
  'grok-4.5-latest': [2, 6],
};

/** Estimated USD cost, or undefined if we have no published rate for the model. */
export function estimateCostUsd(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  const rate = MODEL_RATES[model];
  if (!rate || inputTokens === undefined || outputTokens === undefined) return undefined;
  const [inRate, outRate] = rate;
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

export interface JsonMeta {
  command: string;
  query: string;
  model: string;
  searchWindowDays: number;
  version: string;
}

/** --json: stable machine-readable schema (for CI, scripts, dashboards). */
export function renderJson(result: GrokResult, meta: JsonMeta): string {
  const { inputTokens, outputTokens, totalTokens } = result.usage ?? {};
  const rawCost = estimateCostUsd(meta.model, inputTokens, outputTokens);
  const estimatedCostUsd = rawCost === undefined ? undefined : Number(rawCost.toFixed(6));
  const content = renumberInlineCitations(result.content, result.citations);
  return `${JSON.stringify(
    {
      tool: 'grokscope',
      version: meta.version,
      command: meta.command,
      query: meta.query,
      model: meta.model,
      searchWindowDays: meta.searchWindowDays,
      generatedAt: new Date().toISOString(),
      content,
      citations: result.citations.map((c, i) => {
        const date = xPostDate(c.url);
        return {
          n: i + 1,
          url: c.url,
          ...(c.title ? { title: c.title } : {}),
          ...(date
            ? { postedAt: date.toISOString().slice(0, 10), recency: recencyTag(date) }
            : {}),
        };
      }),
      allSourceUrls: result.allSourceUrls,
      usage: { inputTokens, outputTokens, totalTokens, estimatedCostUsd },
    },
    null,
    2,
  )}\n`;
}
