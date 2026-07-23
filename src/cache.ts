/**
 * Dependency-free file cache for `/v1/responses` bodies.
 *
 * Identical repeats and format re-renders (same request, different `--json`/`--md`)
 * cost nothing: the raw API body is keyed by a sha256 of the canonical request
 * and re-parsed through the same `parseResponse` + formatter as a live run.
 *
 * Layout:  <GROKSCOPE_HOME>/cache/<key>.json   (default home: ~/.grokscope)
 * Only Node builtins — no native deps, no SQLite.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CacheMeta {
  command: string;
  query: string;
  model: string;
  days: number;
  /** ISO timestamp the entry was written. */
  createdAt: string;
}

export interface CacheEntry {
  key: string;
  meta: CacheMeta;
  /** The raw `/v1/responses` body, for `parseResponse`. */
  response: Record<string, unknown>;
  /** How old the file is, in ms (from its mtime). */
  ageMs: number;
}

interface CacheFile {
  version: number;
  meta: CacheMeta;
  response: Record<string, unknown>;
}

const FILE_VERSION = 1;

/** Root for all persisted state; overridable for tests and isolation. */
export function grokscopeHome(): string {
  return process.env.GROKSCOPE_HOME ?? path.join(os.homedir(), '.grokscope');
}

function cacheDir(): string {
  return path.join(grokscopeHome(), 'cache');
}

/** Deterministic JSON: object keys sorted recursively so the key is stable. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical request — the same request always maps to the same file. */
export function cacheKey(input: {
  model: string;
  system: string;
  user: string;
  xSearch: unknown;
}): string {
  const json = JSON.stringify(canonical({
    model: input.model,
    system: input.system,
    user: input.user,
    xSearch: input.xSearch ?? {},
  }));
  return createHash('sha256').update(json).digest('hex');
}

/** A cached entry, or undefined on a miss / entry older than maxAgeMs. */
export function get(key: string, maxAgeMs: number): CacheEntry | undefined {
  const file = path.join(cacheDir(), `${key}.json`);
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
    if (!parsed || typeof parsed.response !== 'object') return undefined;
    return { key, meta: parsed.meta, response: parsed.response, ageMs };
  } catch {
    return undefined;
  }
}

/** Store the raw response body plus its metadata. */
export function put(key: string, response: Record<string, unknown>, meta: CacheMeta): void {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const payload: CacheFile = { version: FILE_VERSION, meta, response };
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(payload));
}

/** All cached entries, newest first (by createdAt). */
export function list(): CacheEntry[] {
  let files: string[];
  try {
    files = readdirSync(cacheDir());
  } catch {
    return [];
  }
  const entries: CacheEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(cacheDir(), f);
    try {
      const ageMs = Date.now() - statSync(full).mtimeMs;
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as CacheFile;
      if (!parsed?.meta || typeof parsed.response !== 'object') continue;
      entries.push({ key: f.slice(0, -5), meta: parsed.meta, response: parsed.response, ageMs });
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
  return entries;
}

export interface CacheStats {
  dir: string;
  entries: number;
  bytes: number;
  /** createdAt of the oldest/newest entries (ISO), if any exist. */
  oldest?: string;
  newest?: string;
}

/** Entry count + on-disk size for `grokscope cache` — free, reads only metadata. */
export function stats(): CacheStats {
  const entries = list(); // newest first
  let bytes = 0;
  for (const e of entries) {
    try {
      bytes += statSync(path.join(cacheDir(), `${e.key}.json`)).size;
    } catch {
      continue;
    }
  }
  return {
    dir: cacheDir(),
    entries: entries.length,
    bytes,
    newest: entries[0]?.meta.createdAt,
    oldest: entries.at(-1)?.meta.createdAt,
  };
}

/** Delete cached entries (optionally only those older than olderThanMs). Returns the count removed. */
export function clear(olderThanMs?: number): number {
  let files: string[];
  try {
    files = readdirSync(cacheDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(cacheDir(), f);
    try {
      if (olderThanMs !== undefined && Date.now() - statSync(full).mtimeMs <= olderThanMs) continue;
      unlinkSync(full);
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}
