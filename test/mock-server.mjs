/**
 * Doc-accurate mock of xAI's POST /v1/responses endpoint, per
 * https://docs.x.ai/developers/tools/x-search and
 * https://docs.x.ai/developers/tools/citations.
 *
 * Validates the incoming request against the documented schema (400 on any
 * mismatch, so e2e catches client-side wire bugs) and answers with realistic
 * Grok 4.5 output: inline [[N]](url) citations, url_citation annotations,
 * top-level `citations`, usage. X post URLs carry real snowflake IDs so
 * recency tags resolve to genuine dates.
 */

import http from 'node:http';

const X_EPOCH = 1288834974657n;

/** Build an x.com status URL whose snowflake ID encodes `daysAgo`. */
export function xUrl(handle, daysAgo) {
  const ms = BigInt(Date.now() - daysAgo * 86_400_000);
  const id = ((ms - X_EPOCH) << 22n).toString();
  return `https://x.com/${handle}/status/${id}`;
}

function validateRequest(body) {
  const errors = [];
  if (body.model !== 'grok-4.5') errors.push(`model must be 'grok-4.5', got ${body.model}`);
  if (typeof body.instructions !== 'string' || !body.instructions)
    errors.push('instructions (system prompt) missing');
  if (!Array.isArray(body.input) || !body.input.length) errors.push('input array missing');
  else if (body.input[0].role !== 'user' || typeof body.input[0].content !== 'string')
    errors.push('input[0] must be {role:"user", content:string}');
  if (!Array.isArray(body.tools) || !body.tools.length) errors.push('tools array missing');
  else {
    const t = body.tools[0];
    if (t.type !== 'x_search') errors.push(`tools[0].type must be 'x_search', got ${t.type}`);
    if (t.from_date && !/^\d{4}-\d{2}-\d{2}$/.test(t.from_date))
      errors.push(`from_date must be YYYY-MM-DD, got ${t.from_date}`);
    if (t.allowed_x_handles && t.excluded_x_handles)
      errors.push('allowed_x_handles and excluded_x_handles cannot be combined');
    const known = new Set([
      'type', 'allowed_x_handles', 'excluded_x_handles', 'from_date', 'to_date',
      'enable_image_understanding', 'enable_video_understanding',
    ]);
    for (const k of Object.keys(t)) if (!known.has(k)) errors.push(`unknown x_search param: ${k}`);
  }
  return errors;
}

function answerFor(userContent) {
  if (/^Compare /.test(userContent)) {
    const m = /^Compare (.+?) vs (.+?) based/.exec(userContent) ?? [null, 'A', 'B'];
    const [a, b] = [m[1], m[2]];
    const u = [xUrl('devopsreact', 2), xUrl('frontendfocus', 3), xUrl('jsperfnerd', 5), xUrl('uiengineer', 1)];
    return {
      text:
        `## ${a} vs ${b}: what X is saying this week\n\n` +
        `**${a} — pros:** mature ecosystem and hiring pool; one senior dev noted migration costs stay predictable [[1]](${u[0]}). ` +
        `**Cons:** several threads complain about re-render overhead in large tables [[2]](${u[1]}).\n\n` +
        `**${b} — pros:** benchmark thread showing 2-4x faster updates on identical workloads got wide agreement [[3]](${u[2]}). ` +
        `**Cons:** smaller ecosystem; devs report hunting for maintained component libraries [[4]](${u[3]}).\n\n` +
        `**Winner:** ${b} on raw performance sentiment this week, with the caveat that ${a} still wins on ecosystem depth and team ramp-up speed.`,
      urls: u,
    };
  }
  if (/^For each topic in \[/.test(userContent)) {
    const inside = /\[([^\]]*)\]/.exec(userContent)?.[1] ?? '';
    const topics = inside.split(',').map((t) => t.trim()).filter(Boolean);
    const urls = topics.map((t, i) => xUrl(`${t.replace(/\W/g, '')}dev`, i + 1));
    const paras = topics.map((t, i) =>
      `**${t}** — sentiment: ${['positive', 'mixed', 'positive'][i % 3]}. ` +
      `Top concern: ${['compile times', 'tooling churn', 'generics ergonomics'][i % 3]} keeps coming up [[${i + 1}]](${urls[i]}). ` +
      `Momentum: ${['rising', 'stable', 'rising'][i % 3]}.`,
    );
    return { text: `## Weekly buzz report\n\n${paras.join('\n\n')}`, urls };
  }
  // default: ask mode
  const u = [xUrl('bunjsdev', 4), xUrl('nodesource', 9), xUrl('backendweekly', 15), xUrl('sveltekitfan', 21)];
  return {
    text:
      `## What developers are saying\n\n` +
      `Bun's 1.3 release thread drew heavy praise for install speed and built-in bundling [[1]](${u[0]}). ` +
      `Node maintainers pushed back with 22.x perf numbers closing the gap [[2]](${u[1]}). ` +
      `Several production users report sticking with Node for ecosystem stability while using Bun for scripts and CI [[3]](${u[2]}), ` +
      `and a widely-shared migration postmortem called the switch "worth it for greenfield only" [[4]](${u[3]}).\n\n` +
      `**Community Verdict:** the community leans Node for production workloads in 2026, with Bun the clear favorite for local tooling and new small services — adoption is rising but bounded by ecosystem compatibility concerns.`,
    urls: u,
  };
}

function buildAnnotations(text) {
  const annotations = [];
  const re = /\[\[(\d+)\]\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    annotations.push({
      type: 'url_citation',
      url: m[2],
      start_index: m.index,
      end_index: m.index + m[0].length,
      title: m[1],
    });
  }
  return annotations;
}

export function createMockServer(opts = {}) {
  const requests = [];
  let postCount = 0;
  const server = http.createServer((req, res) => {
    const badKey = (req.headers.authorization ?? '') === 'Bearer bad-key';

    // GET /models — used by `grokscope doctor` (free key validation)
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      if (badKey || !/^Bearer .+/.test(req.headers.authorization ?? '')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'grok-4.5' }, { id: 'grok-4.5-latest' }, { id: 'grok-3-mini' }],
        }),
      );
      return;
    }

    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (badKey || !/^Bearer .+/.test(req.headers.authorization ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing or invalid bearer token' } }));
      return;
    }
    // opts.failFirst: make the first N POSTs return 429 (exercises client retry)
    postCount += 1;
    if (opts.failFirst && postCount <= opts.failFirst) {
      requests.push({ rateLimited: true });
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const errors = validateRequest(body);
      if (errors.length) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `schema violations: ${errors.join('; ')}` } }));
        return;
      }
      const { text, urls } = answerFor(body.input[0].content);
      const payload = {
        id: 'resp_mock_001',
        object: 'response',
        status: 'completed',
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: buildAnnotations(text) }],
          },
        ],
        citations: urls,
        usage: { input_tokens: 1180, output_tokens: 420, total_tokens: 1600, num_sources_used: urls.length },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return {
    requests,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Standalone: `node test/mock-server.mjs` for manual demos.
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const mock = createMockServer();
  mock.listen().then((port) => {
    console.log(`Mock xAI API listening on http://127.0.0.1:${port}/v1`);
    console.log(`Try:  $env:GROK_API_KEY='test'; $env:GROK_BASE_URL='http://127.0.0.1:${port}/v1'; grokscope ask "bun vs node"`);
  });
}
