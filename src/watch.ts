/**
 * `grokscope watch` — track community sentiment for a set of topics over time.
 *
 * Topics live in <GROKSCOPE_HOME>/watch.json. Each `watch run` executes one
 * trending-style query over all watched topics, extracts a structured reading
 * (sentiment + momentum) per topic from the report, and appends a snapshot to
 * <GROKSCOPE_HOME>/watch-history.jsonl so the next run can show what moved.
 *
 * Parsing is defensive: the trending prompt demands exact "sentiment: <label>"
 * and "Momentum: <label>" phrases, but a reading the model didn't state
 * clearly becomes 'unclear' rather than a guess.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { grokscopeHome } from './cache.js';

export type Sentiment = 'positive' | 'negative' | 'mixed' | 'unclear';
export type Momentum = 'rising' | 'falling' | 'stable' | 'unclear';

export interface TopicReading {
  topic: string;
  sentiment: Sentiment;
  momentum: Momentum;
}

export interface WatchSnapshot {
  /** ISO timestamp the snapshot was taken. */
  at: string;
  days: number;
  model: string;
  readings: TopicReading[];
}

/** A current reading joined against the previous snapshot's reading for the topic. */
export interface TopicDelta extends TopicReading {
  prevSentiment?: Sentiment;
  prevMomentum?: Momentum;
  changed: boolean;
}

function watchFile(): string {
  return path.join(grokscopeHome(), 'watch.json');
}

function historyFile(): string {
  return path.join(grokscopeHome(), 'watch-history.jsonl');
}

export function loadTopics(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(watchFile(), 'utf8')) as { topics?: unknown };
    return Array.isArray(parsed?.topics)
      ? parsed.topics.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function saveTopics(topics: string[]): void {
  mkdirSync(grokscopeHome(), { recursive: true });
  writeFileSync(watchFile(), `${JSON.stringify({ version: 1, topics }, null, 2)}\n`);
}

/** All snapshots, oldest first (file append order). Bad lines are skipped. */
export function loadSnapshots(): WatchSnapshot[] {
  let raw: string;
  try {
    raw = readFileSync(historyFile(), 'utf8');
  } catch {
    return [];
  }
  const snaps: WatchSnapshot[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as WatchSnapshot;
      if (typeof parsed?.at === 'string' && Array.isArray(parsed.readings)) snaps.push(parsed);
    } catch {
      continue;
    }
  }
  return snaps;
}

export function appendSnapshot(snap: WatchSnapshot): void {
  mkdirSync(grokscopeHome(), { recursive: true });
  appendFileSync(historyFile(), `${JSON.stringify(snap)}\n`);
}

/**
 * Pull a {sentiment, momentum} reading per topic out of a trending report.
 * The topic's paragraph is located by name (case-insensitive), then the exact
 * label words are matched; anything else reads as 'unclear'.
 */
export function parseTopicReadings(content: string, topics: string[]): TopicReading[] {
  const paragraphs = content.split(/\n{2,}/);
  return topics.map((topic) => {
    const para = paragraphs.find((p) => p.toLowerCase().includes(topic.toLowerCase())) ?? '';
    const s = /sentiment[^a-z]{0,10}(positive|negative|mixed)/i.exec(para)?.[1]?.toLowerCase();
    const m = /momentum[^a-z]{0,10}(?:direction[^a-z]{0,10})?(rising|falling|stable)/i
      .exec(para)?.[1]
      ?.toLowerCase();
    return {
      topic,
      sentiment: (s as Sentiment | undefined) ?? 'unclear',
      momentum: (m as Momentum | undefined) ?? 'unclear',
    };
  });
}

/** Join current readings against the previous snapshot (matched by topic, case-insensitive). */
export function diffReadings(current: TopicReading[], prev?: WatchSnapshot): TopicDelta[] {
  const prevByTopic = new Map((prev?.readings ?? []).map((r) => [r.topic.toLowerCase(), r]));
  return current.map((r) => {
    const p = prevByTopic.get(r.topic.toLowerCase());
    if (!p) return { ...r, changed: false };
    return {
      ...r,
      prevSentiment: p.sentiment,
      prevMomentum: p.momentum,
      changed: p.sentiment !== r.sentiment || p.momentum !== r.momentum,
    };
  });
}

/**
 * Plain-text "what moved" block appended after the report. Plain arrows only,
 * so it reads the same in a terminal, a piped file, and a --md document.
 */
export function renderDeltas(deltas: TopicDelta[], prevAt: string): string {
  const width = Math.max(...deltas.map((d) => d.topic.length), 4) + 2;
  const lines = deltas.map((d) => {
    const pad = d.topic.padEnd(width);
    if (d.prevSentiment === undefined) return `  ${pad}new topic (${d.sentiment}, ${d.momentum})`;
    if (!d.changed) return `  ${pad}no change (${d.sentiment}, ${d.momentum})`;
    const parts: string[] = [];
    if (d.prevSentiment !== d.sentiment) parts.push(`sentiment ${d.prevSentiment} -> ${d.sentiment}`);
    if (d.prevMomentum !== d.momentum) parts.push(`momentum ${d.prevMomentum} -> ${d.momentum}`);
    return `  ${pad}${parts.join('   ')}`;
  });
  return `Changes since ${prevAt.slice(0, 10)}\n${lines.join('\n')}`;
}
