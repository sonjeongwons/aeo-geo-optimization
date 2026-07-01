/**
 * src/judge/citation.ts — deterministic CITATION detection (hi-end audit MUST #2).
 *
 * A MENTION is the brand named anywhere in prose. A CITATION is the stronger,
 * commercially-decisive signal: the brand presented as a clickable/linked SOURCE
 * or explicit attribution. Answer engines surface citations far less often than
 * mentions, and citations are what actually drive referral traffic — so the
 * engine measures them as a separate channel (SMR_citation) rather than folding
 * them into the mention rate.
 *
 * This module is the rule-fallback / verification counterpart to the LLM judge's
 * citation_present field: it finds links DETERMINISTICALLY so a citation can be
 * confirmed (or recovered when the LLM judge is unavailable) without trusting the
 * model's self-report.
 *
 * Detected forms (any whose link target OR anchor text contains a brand alias):
 *   1. Markdown link            [anchor](https://url)
 *   2. HTML anchor              <a href="https://url">anchor</a>
 *   3. Explicit attribution     "Source: https://brand-url"  /  "(brand.com)"
 *
 * Conservative by design: a bare brand name in prose is NEVER a citation. We only
 * emit a citation when the alias sits inside an actual link/attribution construct,
 * because over-counting citations would overstate the very metric the engine sells.
 *
 * Pure — no IO, no pg, no @google/genai.
 */

import { normalizeForMatch } from "../domain/rank.js";

export interface CitationDetection {
  present: boolean;
  /** The cited URL (href / markdown target / attribution URL). Null if none captured. */
  url: string | null;
  /** The anchor text or attribution span that constitutes the citation. Null if none. */
  quote: string | null;
}

const NO_CITATION: CitationDetection = { present: false, url: null, quote: null };

/**
 * True when `haystack` contains any brand alias as a BOUNDED token (not a
 * substring of a larger alphanumeric run). Fixes a false-positive where alias
 * "emora" matched inside "memora-health.com" / "emorandum.io" and credited a
 * non-brand URL as a brand citation (SOTA v4 self-audit bug fix). A match counts
 * only when the char before and after the alias is NOT [a-z0-9] (or a string
 * edge) — so emora.ai / www.emora.ai / [에모라] still match.
 */
function containsAlias(haystack: string, normalizedAliases: string[]): boolean {
  if (!haystack) return false;
  const norm = normalizeForMatch(haystack);
  return normalizedAliases.some((a) => a.length > 0 && hasBoundedMatch(norm, a));
}

/** Find `needle` in `hay` delimited by non-alphanumeric chars (or string edges). */
function hasBoundedMatch(hay: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : hay[i - 1]!;
    const afterIdx = i + needle.length;
    const after = afterIdx >= hay.length ? "" : hay[afterIdx]!;
    const okBefore = before === "" || !/[a-z0-9]/.test(before);
    const okAfter = after === "" || !/[a-z0-9]/.test(after);
    if (okBefore && okAfter) return true;
    from = i + 1;
  }
}

/**
 * Detect whether the brand is CITED (linked/attributed), not merely mentioned.
 *
 * @param answerText     Raw answer text (may be null/empty → no citation).
 * @param brandAliases   Brand canonical name + aliases (NOT pre-normalized).
 * @returns the first qualifying citation, or {present:false} when none.
 */
export function detectCitation(
  answerText: string | null | undefined,
  brandAliases: string[]
): CitationDetection {
  if (!answerText || answerText.trim() === "") return NO_CITATION;

  const aliases = brandAliases
    .map((a) => normalizeForMatch(a))
    .filter((a) => a.length > 0);
  if (aliases.length === 0) return NO_CITATION;

  // --- 1. Markdown links: [anchor](url) -----------------------------------
  // Anchor may not contain unescaped ']'; url runs to the first ')'.
  const md = /\[([^\]]*)\]\(\s*(<)?([^)\s>]+)/g;
  for (let m = md.exec(answerText); m !== null; m = md.exec(answerText)) {
    const anchor = m[1] ?? "";
    const url = (m[3] ?? "").trim();
    if (containsAlias(anchor, aliases) || containsAlias(url, aliases)) {
      return { present: true, url: url || null, quote: anchor || url || null };
    }
  }

  // --- 2. HTML anchors: <a ... href="url" ...>anchor</a> ------------------
  const anchorTag = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = anchorTag.exec(answerText); m !== null; m = anchorTag.exec(answerText)) {
    const url = (m[1] ?? "").trim();
    const anchor = stripTags(m[2] ?? "");
    if (containsAlias(anchor, aliases) || containsAlias(url, aliases)) {
      return { present: true, url: url || null, quote: anchor || url || null };
    }
  }

  // --- 3. Explicit attribution: "Source: <url-with-brand>" or "(brand.com)" -
  // Match a URL token that itself carries a brand alias (e.g. https://emora.ai/x,
  // www.emora.ai, emora.ai). This catches footnote/reference-style citations the
  // markdown/HTML passes miss. Bare prose names are excluded (must look like a URL).
  const urlToken = /\b((?:https?:\/\/|www\.)[^\s)<>\]]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s)<>\]]*)?)/gi;
  for (let m = urlToken.exec(answerText); m !== null; m = urlToken.exec(answerText)) {
    const token = (m[1] ?? "").trim();
    // Require it to look like a domain/URL (contains a dot or scheme) AND carry a brand alias.
    if ((token.includes(".") || /^https?:/i.test(token)) && containsAlias(token, aliases)) {
      return { present: true, url: token, quote: token };
    }
  }

  return NO_CITATION;
}

/** Strip HTML tags from an anchor's inner text. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}
