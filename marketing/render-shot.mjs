/**
 * Build a real screenshot from a cached grokscope --json result.
 *
 * Renders the cached result through the SHIPPED formatter with ansi=true, so the
 * image shows exactly what a real TTY shows — same headers, same clickable
 * citations, same recency tags — then converts that ANSI to HTML. Nothing here
 * invents content: every character comes from a real API response.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderResult } from 'file:///d:/Repos/ideas/grokscope/dist/formatter.js';

const [, , jsonPath, outPath, cmdLine, maxLinesArg] = process.argv;
const maxLines = Number(maxLinesArg) || 0;
const d = JSON.parse(readFileSync(jsonPath, 'utf8'));

// Reconstruct the GrokResult the formatter expects.
const result = {
  content: d.content,
  citations: d.citations.map((c) => ({ url: c.url, ...(c.title ? { title: c.title } : {}) })),
  usage: d.usage,
  allSourceUrls: d.allSourceUrls,
};

let ansi = renderResult(result, true);

// The real answer runs ~60 lines — far too tall for a usable image. Keep the
// opening summary and the full Sources block (the part that proves the tool
// cites real posts), and mark the elision honestly.
if (maxLines) {
  const all = ansi.split('\n');
  const srcIdx = all.findIndex((l) => l.includes('Sources'));
  // Only trim when Sources actually falls past the cut. Otherwise the head
  // already contains them and appending would duplicate the whole block.
  if (srcIdx > maxLines) {
    ansi = [
      ...all.slice(0, maxLines),
      '',
      `\x1b[2m  … ${srcIdx - maxLines} more lines …\x1b[22m`,
      ...all.slice(srcIdx),
    ].join('\n');
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ANSI + OSC 8 -> HTML spans. Mirrors the SGR codes formatter.ts emits. */
function ansiToHtml(input) {
  let out = '';
  let i = 0;
  const open = [];
  const closeAll = () => open.splice(0).reverse().map(() => '</span>').join('');
  while (i < input.length) {
    // OSC 8 hyperlink: ESC ]8;;URL ESC \ label ESC ]8;; ESC \
    if (input.startsWith('\x1b]8;;', i)) {
      const urlEnd = input.indexOf('\x1b\\', i);
      const url = input.slice(i + 5, urlEnd);
      const rest = input.indexOf('\x1b]8;;\x1b\\', urlEnd);
      const label = input.slice(urlEnd + 2, rest === -1 ? undefined : rest);
      if (!url) { i = urlEnd + 2; continue; }
      out += `<a href="${esc(url)}">${esc(label.replace(/\x1b\[[0-9;]*m/g, ''))}</a>`;
      // Terminator is ESC ] 8 ; ; ESC \  == 7 chars; advancing 6 leaks a stray "\".
      i = (rest === -1 ? urlEnd : rest) + 7;
      continue;
    }
    const m = /^\x1b\[([0-9;]*)m/.exec(input.slice(i));
    if (m) {
      const code = m[1];
      const cls = { 1: 'b', 2: 'd', 4: 'u', 34: 'c' }[code];
      if (cls) { out += `<span class="${cls}">`; open.push(cls); }
      else if (['22', '24', '39', '0'].includes(code) && open.length) { out += '</span>'; open.pop(); }
      i += m[0].length;
      continue;
    }
    out += esc(input[i]);
    i += 1;
  }
  return out + closeAll();
}

const body = ansiToHtml(ansi);

const usage = d.usage;
const costLine = `${usage.totalTokens.toLocaleString()} tokens · ~$${usage.estimatedCostUsd.toFixed(4)}`;

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1200px; background:linear-gradient(135deg,#1d9bf0 0%,#0a4d7a 100%); display:flex; align-items:center; justify-content:center; padding:32px 0; font-family:"Cascadia Code",Consolas,monospace; }
  .win { width:1120px; background:#0f1419; border-radius:12px; box-shadow:0 24px 80px rgba(0,0,0,.5); overflow:hidden; }
  .bar { background:#1c2733; padding:10px 14px; display:flex; gap:8px; align-items:center; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title { color:#8b98a5; font-size:13px; margin-left:12px; }
  .body { padding:20px 24px 22px; color:#e7e9ea; font-size:13.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
  .prompt { color:#7ee787; }
  .b { font-weight:bold; color:#fff; }
  .d { color:#8b949e; }
  .u { text-decoration:underline; }
  .c { color:#58a6ff; }
  a { color:#58a6ff; text-decoration:underline; }
  .cost { color:#8b949e; margin-top:10px; }
</style></head>
<body><div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">grokscope — Windows Terminal</span></div>
  <div class="body"><span class="prompt">❯</span> ${esc(cmdLine)}

${body}
<span class="cost">${costLine}</span></div>
</div></body></html>`;

writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${html.length} bytes)`);
