/**
 * src/metrics/botAccessibility.ts — PURE robots.txt parser + answer-engine bot
 * accessibility detector for the earned-source corpus.
 *
 * §0 NOTE: Fetching a third-party domain's robots.txt is a borderline §0 action
 * that MUST sit behind a fetch-allowlist at the INTEGRATION layer — DEFERRED and
 * explicitly NOT implemented here. This module ONLY parses already-obtained text;
 * it performs no IO, no network requests, and no pg access.
 *
 * §7 HONESTY: When robots.txt text is null/absent (fetch failed or was not
 * performed), every bot's status is "unknown" — NOT "allowed". Callers MUST NOT
 * assume accessibility when text is absent.
 *
 * PURE — no IO, no pg, no network. Deterministic given the same inputs.
 */

/** The answer-engine crawler user-agents we track. */
export const ANSWER_ENGINE_BOTS: readonly string[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "ClaudeBot",
  "Claude-SearchBot",
  "anthropic-ai",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "Applebot-Extended",
] as const;

/** A parsed representation of a robots.txt file. */
export interface RobotsRules {
  groups: Array<{
    agents: string[];
    allow: string[];
    disallow: string[];
  }>;
}

/** §7 bot accessibility status — "unknown" when robots.txt was unavailable. */
export type BotStatus = "allowed" | "disallowed" | "unknown";

/**
 * Parse a robots.txt text string into structured rule groups.
 *
 * - Directives are case-insensitive.
 * - Consecutive `User-agent:` lines before any Allow/Disallow form one group.
 * - Comments (`#`) and blank lines are ignored.
 * - A `Disallow:` with an empty value means "allow all" (no restriction for that rule).
 */
export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];

  let currentAgents: string[] = [];
  let currentAllow: string[] = [];
  let currentDisallow: string[] = [];
  let inGroup = false;

  const flush = (): void => {
    if (currentAgents.length > 0) {
      groups.push({
        agents: currentAgents,
        allow: currentAllow,
        disallow: currentDisallow,
      });
    }
    currentAgents = [];
    currentAllow = [];
    currentDisallow = [];
    inGroup = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // A line that starts with '#' (after trimming) is a comment — skip entirely.
    // Do NOT treat it as a blank line that ends a group.
    const trimmedRaw = rawLine.trim();
    if (trimmedRaw.startsWith("#")) continue;

    // Strip inline comments from non-comment lines, then trim.
    const commentIdx = rawLine.indexOf("#");
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();

    if (line === "") {
      // Blank line ends a group
      if (inGroup) flush();
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "user-agent") {
      if (inGroup) {
        // Consecutive user-agent lines belong to the same group; but if we
        // already emitted an Allow/Disallow, this starts a new group.
        if (currentAllow.length > 0 || currentDisallow.length > 0) {
          flush();
        }
      }
      currentAgents.push(value);
      inGroup = true;
    } else if (directive === "allow") {
      if (currentAgents.length > 0) currentAllow.push(value);
    } else if (directive === "disallow") {
      // Empty Disallow: means "allow all" — we represent this by NOT adding to
      // the disallow list (an empty disallow list → allowed).
      if (currentAgents.length > 0 && value !== "") {
        currentDisallow.push(value);
      }
    }
    // Other directives (Sitemap:, Crawl-delay:, etc.) are ignored.
  }

  // Flush the last group.
  if (currentAgents.length > 0) flush();

  return { groups };
}

// ---------------------------------------------------------------------------
// Internal path-matching helpers
// ---------------------------------------------------------------------------

/**
 * Convert a robots.txt path pattern (supporting `*` and `$`) into a
 * plain RegExp that matches against URL paths.
 */
function patternToRegex(pattern: string): RegExp {
  // Escape all regex special chars except * and $
  let src = pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  // Replace * with .* (matches any sequence)
  src = src.replace(/\*/g, ".*");
  // $ at end means end-anchor; $ elsewhere is literal (rare in practice)
  if (src.endsWith("$")) {
    src = src.slice(0, -1) + "$";
  } else {
    // No end anchor: pattern must match from the start as a prefix
    src = src; // will be anchored at start only
  }
  return new RegExp("^" + src);
}

/**
 * Return the match length of `pattern` against `path`, or -1 if no match.
 * "Match length" = length of the PATTERN (not the match result) — used as
 * specificity score per the robots.txt standard.
 */
function matchLength(pattern: string, path: string): number {
  const re = patternToRegex(pattern);
  return re.test(path) ? pattern.length : -1;
}

// ---------------------------------------------------------------------------

/**
 * Determine whether a given user-agent is allowed to access a path according
 * to the parsed robots rules.
 *
 * Selection logic:
 * 1. Among all groups, find those whose `agents` list contains a token that
 *    is a case-insensitive prefix-of (or exact match for) `userAgent`.
 * 2. Prefer the most specific non-wildcard group (longest matching agent token).
 * 3. Fall back to the `*` group.
 * 4. If no group matches at all → allowed (true).
 *
 * Within the chosen group, evaluate Allow/Disallow by longest path match;
 * on equal length, Allow wins. Empty disallow list → allowed.
 */
export function isAllowed(
  rules: RobotsRules,
  userAgent: string,
  path: string = "/",
): boolean {
  const uaLower = userAgent.toLowerCase();

  // Find the best matching group.
  let bestGroup: RobotsRules["groups"][number] | null = null;
  let bestScore = -1; // -1 = no match; 0 = wildcard '*'; >0 = specific length
  let wildcardGroup: RobotsRules["groups"][number] | null = null;

  for (const group of rules.groups) {
    for (const agent of group.agents) {
      const agentLower = agent.toLowerCase();
      if (agentLower === "*") {
        // Keep the wildcard group as fallback only
        wildcardGroup = group;
        continue;
      }
      // RFC 9309 §2.2.1: a group applies only when the robots product token is a
      // PREFIX of the crawler's user-agent (forward direction only; exact match
      // is subsumed). The reverse direction was WRONG (sweep v9 Z2): a rule
      // written for a longer, distinct token ("ClaudeBot-Special") would capture a
      // shorter tracked bot ("ClaudeBot") and outscore the correct "*" fallback,
      // returning disallowed instead of allowed.
      if (uaLower.startsWith(agentLower)) {
        const score = agentLower.length;
        if (score > bestScore) {
          bestScore = score;
          bestGroup = group;
        }
      }
    }
  }

  const group = bestGroup ?? wildcardGroup;
  if (group === null) return true; // No group matches → allowed

  // Within the group, find the best matching Allow/Disallow rule.
  let bestAllowLen = -1;
  let bestDisallowLen = -1;

  for (const pattern of group.allow) {
    const len = matchLength(pattern, path);
    if (len > bestAllowLen) bestAllowLen = len;
  }
  for (const pattern of group.disallow) {
    const len = matchLength(pattern, path);
    if (len > bestDisallowLen) bestDisallowLen = len;
  }

  if (bestAllowLen < 0 && bestDisallowLen < 0) return true; // Nothing matched → allowed
  if (bestAllowLen >= bestDisallowLen) return true; // Allow wins ties
  return false;
}

// ---------------------------------------------------------------------------

/**
 * Compute per-bot accessibility status for a single domain's robots.txt text.
 *
 * §7: When `robotsText` is `null` (fetch failed / unavailable), every bot is
 * "unknown" — callers MUST NOT infer "allowed" from absence of text.
 */
export function botAccessibility(
  robotsText: string | null,
  bots: readonly string[] = ANSWER_ENGINE_BOTS,
): Array<{ bot: string; status: BotStatus }> {
  if (robotsText === null) {
    return bots.map((bot) => ({ bot, status: "unknown" }));
  }

  const rules = parseRobots(robotsText);
  return bots.map((bot) => ({
    bot,
    status: isAllowed(rules, bot, "/") ? "allowed" : "disallowed",
  }));
}

// ---------------------------------------------------------------------------

export interface AccessibilityCorpus {
  /** Total number of domains in the input. */
  nDomains: number;
  /** Per-bot aggregate counts. `allowedShare` is over domains with KNOWN status only. */
  perBot: Array<{
    bot: string;
    allowed: number;
    disallowed: number;
    unknown: number;
    /** allowed / (allowed + disallowed); 0 when no domain has known status. */
    allowedShare: number;
  }>;
  /**
   * Per-domain crawl eligibility: fraction of bots that are allowed among
   * those with KNOWN status. 0 when all bots are unknown.
   */
  perDomain: Array<{ domain: string; crawlEligibility: number }>;
}

/**
 * Aggregate bot accessibility across an earned-source corpus of domains.
 *
 * - `allowedShare` per bot = allowed / (allowed + disallowed) [KNOWN only; 0 when none known].
 * - `crawlEligibility` per domain = allowedBots / knownBots [0 when none known].
 * - `nDomains` = `perDomain.length`.
 *
 * PURE — deterministic given the same inputs.
 */
export function aggregateAccessibility(
  perDomain: ReadonlyArray<{ domain: string; robotsText: string | null }>,
  bots: readonly string[] = ANSWER_ENGINE_BOTS,
): AccessibilityCorpus {
  const nDomains = perDomain.length;

  // Accumulator per bot
  const botCounts = new Map<string, { allowed: number; disallowed: number; unknown: number }>();
  for (const bot of bots) {
    botCounts.set(bot, { allowed: 0, disallowed: 0, unknown: 0 });
  }

  const domainRows: AccessibilityCorpus["perDomain"] = [];

  for (const entry of perDomain) {
    const statuses = botAccessibility(entry.robotsText, bots);

    let allowedCount = 0;
    let knownCount = 0;

    for (const { bot, status } of statuses) {
      const acc = botCounts.get(bot);
      if (acc !== undefined) {
        if (status === "allowed") {
          acc.allowed += 1;
          allowedCount += 1;
          knownCount += 1;
        } else if (status === "disallowed") {
          acc.disallowed += 1;
          knownCount += 1;
        } else {
          acc.unknown += 1;
        }
      }
    }

    domainRows.push({
      domain: entry.domain,
      crawlEligibility: knownCount > 0 ? allowedCount / knownCount : 0,
    });
  }

  const perBotRows: AccessibilityCorpus["perBot"] = bots.map((bot) => {
    const acc = botCounts.get(bot) ?? { allowed: 0, disallowed: 0, unknown: 0 };
    const known = acc.allowed + acc.disallowed;
    return {
      bot,
      allowed: acc.allowed,
      disallowed: acc.disallowed,
      unknown: acc.unknown,
      allowedShare: known > 0 ? acc.allowed / known : 0,
    };
  });

  return { nDomains, perBot: perBotRows, perDomain: domainRows };
}
