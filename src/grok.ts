/**
 * Thin wrapper around the xAI Responses API (POST {base}/responses).
 *
 * Grok 4.5's server-side agentic tools (x_search, web_search) are exposed on
 * the Responses API — not on legacy chat/completions — per
 * https://docs.x.ai/developers/tools/x-search. The interface is
 * OpenAI-compatible: Bearer auth, JSON in/out (https://docs.x.ai/overview).
 */

export interface XSearchConfig {
  /** Only consider posts from these X handles (max 20, no leading @). */
  allowedHandles?: string[];
  /** Never include posts from these X handles (max 20, no leading @). */
  excludedHandles?: string[];
  /** ISO date (YYYY-MM-DD) — search start. */
  fromDate?: string;
  /** ISO date (YYYY-MM-DD) — search end. */
  toDate?: string;
  /** Let the agent analyze images inside X posts. */
  imageUnderstanding?: boolean;
  /** Let the agent analyze videos inside X posts. */
  videoUnderstanding?: boolean;
}

export interface Citation {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface GrokResult {
  /** Assistant text (markdown, with inline [[N]](url) citations). */
  content: string;
  /** Inline url_citation annotations, deduped by URL. */
  citations: Citation[];
  /** Every source URL the agent encountered (top-level `citations` field). */
  allSourceUrls: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface GrokRequest {
  system: string;
  user: string;
  xSearch?: XSearchConfig;
}

export class GrokApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GrokApiError';
  }
}

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4.5';
const REQUEST_TIMEOUT_MS = 300_000; // agentic search + reasoning can run minutes
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function resolvedModel(): string {
  return process.env.GROK_MODEL ?? DEFAULT_MODEL;
}

export function resolvedBaseUrl(): string {
  return (process.env.GROK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function buildXSearchTool(cfg: XSearchConfig): Record<string, unknown> {
  if (cfg.allowedHandles?.length && cfg.excludedHandles?.length) {
    throw new GrokApiError(
      'allowed_x_handles and excluded_x_handles cannot be used together',
    );
  }
  const tool: Record<string, unknown> = { type: 'x_search' };
  if (cfg.allowedHandles?.length) tool.allowed_x_handles = cfg.allowedHandles;
  if (cfg.excludedHandles?.length) tool.excluded_x_handles = cfg.excludedHandles;
  if (cfg.fromDate) tool.from_date = cfg.fromDate;
  if (cfg.toDate) tool.to_date = cfg.toDate;
  if (cfg.imageUnderstanding) tool.enable_image_understanding = true;
  if (cfg.videoUnderstanding) tool.enable_video_understanding = true;
  return tool;
}

export async function askGrok(req: GrokRequest, apiKey: string): Promise<GrokResult> {
  const baseUrl = resolvedBaseUrl();
  const model = resolvedModel();

  const body = {
    model,
    instructions: req.system,
    input: [{ role: 'user', content: req.user }],
    tools: [buildXSearchTool(req.xSearch ?? {})],
  };

  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new GrokApiError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 1500);
        continue;
      }
      throw new GrokApiError(
        `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}. Check your connection (or GROK_BASE_URL if set).`,
      );
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, 30_000)
        : attempt * 1500;
      await res.text().catch(() => {}); // drain body before retrying
      await sleep(waitMs);
      continue;
    }
    break;
  }

  if (!res) throw new GrokApiError('No response from the xAI API');

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 401 || res.status === 403) {
      throw new GrokApiError(
        `Authentication failed (${res.status}). Check GROK_API_KEY — get a key at https://console.x.ai${detail}`,
        res.status,
      );
    }
    if (res.status === 402) {
      throw new GrokApiError(
        `Your xAI account is out of credits — top up at https://console.x.ai${detail}`,
        402,
      );
    }
    if (res.status === 429) {
      throw new GrokApiError(
        `Rate limited by the xAI API (retried ${MAX_ATTEMPTS}x) — wait a minute and try again.${detail}`,
        429,
      );
    }
    throw new GrokApiError(`xAI API error ${res.status}${detail}`, res.status);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const result = parseResponse(data);
  if (!result.content.trim() && data.status === 'incomplete') {
    throw new GrokApiError(
      'The model returned an incomplete response (likely hit a token limit). Try a narrower question.',
    );
  }
  return result;
}

export interface ApiHealth {
  reachable: boolean;
  latencyMs?: number;
  keyValid?: boolean;
  models?: string[];
  status?: number;
  error?: string;
}

/** Free setup check for `grokscope doctor`: GET {base}/models validates the key without spending tokens. */
export async function checkApi(apiKey: string): Promise<ApiHealth> {
  const baseUrl = resolvedBaseUrl();
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, latencyMs, keyValid: false, status: res.status };
    }
    if (!res.ok) {
      return { reachable: true, latencyMs, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const models = Array.isArray(data?.data)
      ? data.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : [];
    return { reachable: true, latencyMs, keyValid: true, models };
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      const msg =
        typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      return msg ? `: ${msg}` : text ? `: ${text.slice(0, 300)}` : '';
    } catch {
      return text ? `: ${text.slice(0, 300)}` : '';
    }
  } catch {
    return '';
  }
}

/** Walk the Responses API `output` array into {content, citations}. */
export function parseResponse(data: Record<string, unknown>): GrokResult {
  let content = '';
  const byUrl = new Map<string, Citation>();

  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as { type?: string; content?: unknown };
    if (msg.type !== 'message' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as {
        type?: string;
        text?: string;
        annotations?: Array<Record<string, unknown>>;
      };
      if (b.type !== 'output_text' || typeof b.text !== 'string') continue;
      content += b.text;
      for (const ann of b.annotations ?? []) {
        if (ann.type === 'url_citation' && typeof ann.url === 'string' && !byUrl.has(ann.url)) {
          byUrl.set(ann.url, {
            url: ann.url,
            title: typeof ann.title === 'string' ? ann.title : undefined,
            startIndex: typeof ann.start_index === 'number' ? ann.start_index : undefined,
            endIndex: typeof ann.end_index === 'number' ? ann.end_index : undefined,
          });
        }
      }
    }
  }

  const allSourceUrls = Array.isArray(data.citations)
    ? data.citations.filter((u): u is string => typeof u === 'string')
    : [];

  // If the model returned no inline annotations, fall back to the top-level
  // source list so callers always have something to show.
  if (byUrl.size === 0) {
    for (const url of allSourceUrls) {
      if (!byUrl.has(url)) byUrl.set(url, { url });
    }
  }

  const usageRaw = (data.usage ?? {}) as Record<string, unknown>;
  const usage = {
    inputTokens: typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : undefined,
    outputTokens: typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : undefined,
    totalTokens: typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
  };

  return { content, citations: [...byUrl.values()], allSourceUrls, usage };
}
