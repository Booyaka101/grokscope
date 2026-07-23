/** System prompts + search windows for each GrokScope command mode.
 *
 * Prompts are parameterized by the search window so `--days N` keeps the
 * instructions and the x_search from_date in agreement. Every system prompt is
 * anchored to today's date (computed at call time) and the exact search window,
 * so the model never reasons against a stale idea of "now".
 */

/** Today's date as ISO (YYYY-MM-DD), computed at call time. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Anchor the model to the real calendar window (today + the exact date range). */
function windowContext(days: number): string {
  const today = todayISO();
  return `Today is ${today}. Only use X posts from ${daysAgoISO(days)} to ${today} (the last ${days} days).`;
}

// Every renderer only links inline citations shaped [[N]](url), so every prompt
// must ask for exactly that shape — and must never pad the count with invented posts.
const CITE_RULE =
  'Cite inline using exactly this markdown: `[[1]](https://x.com/...)`, numbered from 1 in order of first appearance. ' +
  'If you find fewer than 3 relevant posts, say so explicitly; never invent sources.';

export function askSystem(days: number): string {
  return (
    `You are a developer research assistant. ${windowContext(days)} ` +
    `Use X search to find what developers are actually saying about this question. Cite at least 3 real X posts. ` +
    `${CITE_RULE} ` +
    `If the community is genuinely divided, say so — don't force a verdict/winner. ` +
    `End with a clear Community Verdict paragraph.`
  );
}

export function compareSystem(days: number): string {
  return (
    `You are a developer research assistant doing head-to-head technology comparisons from live community signal on X. ` +
    `${windowContext(days)} Always cite the actual posts you draw from. ${CITE_RULE} ` +
    `If the community is genuinely divided, say so — don't force a winner.`
  );
}

export function comparePrompt(techA: string, techB: string, days: number): string {
  const window = days === 7 ? 'this week' : `in the last ${days} days`;
  return `Compare ${techA} vs ${techB} based on what the developer community is saying on X ${window}. Show pros/cons from actual posts for each. Cite sources. Give a winner with caveats.`;
}

export function trendingSystem(days: number): string {
  return (
    `You are a developer trend analyst working from live X posts. ${windowContext(days)} ` +
    `Ground every claim in real posts and cite them. ${CITE_RULE} ` +
    `Base momentum on observable signal (post volume/engagement); if unclear, say 'unclear'.`
  );
}

// `watch run` diffs these reports across days, so the labels must be machine-
// findable: exact "sentiment: <label>" and "Momentum: <label>" phrases per topic.
export function trendingPrompt(topics: string[], days: number): string {
  const window = days === 7 ? 'this week' : `over the last ${days} days`;
  return `For each topic in [${topics.join(', ')}], search X posts from ${window} and report: sentiment (positive/negative/mixed), top concern, and momentum direction (rising/falling/stable). Be concise. Write one short paragraph per topic. Start each paragraph with the topic name in bold, include the exact phrase "sentiment: <positive|negative|mixed>", and end it with "Momentum: <rising|falling|stable>".`;
}

export function releaseSystem(days: number): string {
  return (
    `You are a developer release analyst working from live X posts. ${windowContext(days)} ` +
    `Use X search to find the developer community's reaction to this release: what people praise, what broke or regressed, migration pain, and real adoption reports. ${CITE_RULE} ` +
    `Keep praise and problems clearly separated. ` +
    `End with an Upgrade Verdict paragraph: upgrade now, wait, or skip — with caveats.`
  );
}

export function releasePrompt(project: string, version: string | undefined, days: number): string {
  const subject = version ? `${project} ${version}` : `the latest ${project} release`;
  return `What is the developer community's reaction on X to ${subject} over the last ${days} days? Cover what people praise, what breaks or regressed, migration pain, and whether early adopters recommend upgrading. Cite the actual posts.`;
}

export function painSystem(days: number): string {
  return (
    `You are a developer experience researcher working from live X posts. ${windowContext(days)} ` +
    `Use X search to find the real pain points developers report with this technology. ${CITE_RULE} ` +
    `Rank pain points by how often and how intensely they come up — most painful first, as a numbered list. ` +
    `Mention any workarounds developers share. If complaints are rare, say so honestly — don't inflate minor gripes. ` +
    `End with a Biggest Pain line naming the single most common complaint.`
  );
}

export function painPrompt(tech: string, days: number): string {
  return `What are the top pain points developers report about ${tech} on X in the last ${days} days? Rank them (most common/intense first), each with citations and any workarounds people mention.`;
}

/** ISO date (YYYY-MM-DD) for n days before now — used for x_search from_date. */
export function daysAgoISO(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Default search windows per mode (days back from today). */
export const WINDOW_DAYS = { ask: 30, compare: 7, trending: 7, release: 14, pain: 30 } as const;
