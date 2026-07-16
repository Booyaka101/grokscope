/** System prompts + search windows for each GrokScope command mode.
 *
 * Prompts are parameterized by the search window so `--days N` keeps the
 * instructions and the x_search from_date in agreement.
 */

export function askSystem(days: number): string {
  const window = days === 30 ? 'the last 30 days' : `the last ${days} days`;
  return `You are a developer research assistant. Use X search to find what developers are actually saying about this question in ${window}. Cite at least 3 real X posts. End with a clear Community Verdict paragraph.`;
}

export const COMPARE_SYSTEM =
  'You are a developer research assistant doing head-to-head technology comparisons from live community signal on X. Always cite the actual posts you draw from.';

export function comparePrompt(techA: string, techB: string, days: number): string {
  const window = days === 7 ? 'this week' : `in the last ${days} days`;
  return `Compare ${techA} vs ${techB} based on what the developer community is saying on X ${window}. Show pros/cons from actual posts for each. Cite sources. Give a winner with caveats.`;
}

export const TRENDING_SYSTEM =
  'You are a developer trend analyst working from live X posts. Ground every claim in real posts and cite them.';

export function trendingPrompt(topics: string[], days: number): string {
  const window = days === 7 ? 'this week' : `over the last ${days} days`;
  return `For each topic in [${topics.join(', ')}], search X posts from ${window} and report: sentiment (positive/negative/mixed), top concern, and momentum direction (rising/falling/stable). Be concise. Write one short paragraph per topic, headed by the topic name.`;
}

/** ISO date (YYYY-MM-DD) for n days before now — used for x_search from_date. */
export function daysAgoISO(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Default search windows per mode (days back from today). */
export const WINDOW_DAYS = { ask: 30, compare: 7, trending: 7 } as const;
