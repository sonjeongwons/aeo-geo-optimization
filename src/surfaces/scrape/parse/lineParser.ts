/**
 * Line AI scrape parser — DESIGN-phase4.md T09.
 *
 * Input: a raw DOM snapshot (structured object) or HTML string from the
 * RPA runner for the Line AI surface (JP/TW/TH markets).
 *
 * PROSE/CITATION SEPARATION invariants (DESIGN-phase4.md):
 *   - answerText contains ONLY the AI-generated prose.
 *   - Citations (source URLs, titles, snippets) go in the citations[] array.
 *   - The judge sees clean prose; brand attribution is faithful.
 *
 * NO_ANSWER: returned (typed value, never thrown) when the Line AI surface did
 *   not produce an AI-generated answer (e.g. only a search results page, or
 *   the AI chat response block is absent for this query).
 *
 * ParseError / DRIFT: returned when the expected DOM/fixture structure has
 *   changed and the parser can no longer locate the answer container.
 *
 * nativeReview: SET TO TRUE — Line is a JP/TW/TH market surface.
 *   Answers in Japanese, Traditional Chinese, and Thai require native-speaker
 *   review before publishing. SMR measurement is IDENTICAL whether the flag
 *   is on or off (advisory metadata only).
 *
 * Markets: ja (Japan), zh-TW (Taiwan), th (Thailand).
 */

import {
  NO_ANSWER,
  type Citation,
  type ParseResult,
  type SurfaceParser,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Fixture / snapshot shape expected from the RPA runner (or test fixtures)
// ---------------------------------------------------------------------------

/**
 * Structured snapshot the RPA runner emits for the Line AI surface.
 *
 * Line AI (LINE の AI アシスタント / LINE AI 助理) is accessible via Line's
 * chat/search interface on mobile and web. The RPA runner extracts the AI
 * response bubble and its linked sources into this normalized snapshot shape.
 *
 * All fields are optional so the parser degrades gracefully on layout drift.
 */
interface LineSnapshot {
  /**
   * The AI-generated answer prose extracted by the RPA runner.
   * Plain text only — no HTML, no embedded citation markers.
   */
  answerBlock?: string | null;
  /**
   * Source citations / linked articles attached to the AI answer.
   * The Line surface often surfaces news or web links alongside AI answers.
   */
  citations?: Array<{
    url?: string | null;
    title?: string | null;
    snippet?: string | null;
    rank?: number | null;
  }> | null;
  /** True when the page / chat returned no AI-generated answer block. */
  noAnswerFound?: boolean;
  /** Raw HTML of the answer container (fallback when answerBlock is absent). */
  answerHtml?: string | null;
  /**
   * Market/locale of the queried Line surface.
   * e.g. "ja", "zh-TW", "th". Stored in rawInput for provenance.
   */
  market?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether raw is a LineSnapshot structured object.
 * Uses duck-typing on known keys — no instanceof, no schema validation.
 */
function isSnapshot(raw: unknown): raw is LineSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    "answerBlock" in obj ||
    "citations" in obj ||
    "noAnswerFound" in obj ||
    "answerHtml" in obj ||
    "market" in obj
  );
}

/**
 * Strip HTML tags from a string for prose-only extraction.
 * Used when `answerHtml` is provided instead of a pre-extracted prose block.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Normalize prose: trim whitespace, collapse runs of blanks.
 */
function normalizeProse(text: string): string {
  return text.replace(/\s{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// LineParser
// ---------------------------------------------------------------------------

export class LineParser implements SurfaceParser<unknown> {
  readonly surfaceId = "line" as const;

  parse(raw: unknown): ParseResult {
    // -----------------------------------------------------------------------
    // Branch 1: structured RPA snapshot (primary path — fixtures + live RPA)
    // -----------------------------------------------------------------------
    if (isSnapshot(raw)) {
      return this._parseSnapshot(raw);
    }

    // -----------------------------------------------------------------------
    // Branch 2: raw HTML string (fallback path)
    // -----------------------------------------------------------------------
    if (typeof raw === "string") {
      return this._parseHtml(raw);
    }

    // -----------------------------------------------------------------------
    // Unexpected input type → DRIFT (parser cannot handle this shape)
    // -----------------------------------------------------------------------
    return {
      ok: false,
      code: "DRIFT",
      message:
        "LineParser: unexpected raw input type — expected LineSnapshot object or HTML string",
      rawFragment: typeof raw,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot path
  // -------------------------------------------------------------------------

  private _parseSnapshot(snap: LineSnapshot): ParseResult {
    // Explicit no-answer signal from RPA runner.
    if (snap.noAnswerFound === true) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Line AI page returned no AI answer block",
      };
    }

    // Extract prose from answerBlock (preferred) or fall back to answerHtml.
    let prose: string | null = null;

    if (typeof snap.answerBlock === "string" && snap.answerBlock.trim() !== "") {
      prose = normalizeProse(snap.answerBlock);
    } else if (
      typeof snap.answerHtml === "string" &&
      snap.answerHtml.trim() !== ""
    ) {
      const stripped = stripHtml(snap.answerHtml);
      if (stripped.length > 0) {
        prose = stripped;
      }
    }

    // No prose found and no explicit noAnswerFound → treat as NO_ANSWER.
    if (prose === null || prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Line AI snapshot contained no extractable answer prose",
      };
    }

    // Build citations list (separate from prose — PROSE/CITATION SEPARATION invariant).
    const citations: Citation[] = [];
    if (Array.isArray(snap.citations)) {
      for (const c of snap.citations) {
        if (typeof c?.url === "string" && c.url.trim() !== "") {
          citations.push({
            url: c.url.trim(),
            ...(typeof c.title === "string" ? { title: c.title.trim() } : {}),
            ...(typeof c.snippet === "string"
              ? { snippet: c.snippet.trim() }
              : {}),
            ...(typeof c.rank === "number" ? { rank: c.rank } : {}),
          });
        }
      }
    }

    return {
      ok: true,
      answer: {
        answerText: prose,
        citations,
        surfaceId: "line",
        rawInput: snap,
        // nativeReview = true: Line is a JP/TW/TH market surface.
        // Answers in ja/zh-TW/th require native-speaker review (advisory flag).
        // SMR measurement is IDENTICAL whether this flag is on or off.
        nativeReview: true,
      },
    };
  }

  // -------------------------------------------------------------------------
  // HTML string path
  // -------------------------------------------------------------------------

  private _parseHtml(html: string): ParseResult {
    // Line AI web interface HTML markers (as of 2025):
    //   - <div data-testid="ai-answer-content"> ... </div>
    //   - <div class="chat-bubble ai-response"> ... </div>
    //   - <div role="article" class="ai-message"> ... </div>
    //
    // These selectors are heuristics for fixture-based testing.
    // The live RPA runner uses Playwright selectors and emits a structured
    // snapshot, so the HTML path is mainly for test fixtures.

    const answerMatch =
      html.match(/data-testid="ai-answer-content"[^>]*>([\s\S]*?)<\/div>/i) ??
      html.match(/class="[^"]*ai-response[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ??
      html.match(/class="[^"]*ai-message[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (!answerMatch || !answerMatch[1]) {
      // No recognizable answer container → DRIFT (layout changed).
      return {
        ok: false,
        code: "DRIFT",
        message:
          "LineParser: could not locate AI answer container in HTML — possible layout drift",
        rawFragment: html.slice(0, 300),
      };
    }

    const prose = normalizeProse(stripHtml(answerMatch[1]));
    if (prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Line AI HTML answer container was empty",
      };
    }

    // Citations: parse <a href="..."> inside the answer block (simple heuristic).
    const citations: Citation[] = [];
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
    let m: RegExpExecArray | null;
    let rank = 1;
    while ((m = linkRe.exec(answerMatch[1])) !== null) {
      const url = m[1]?.trim();
      const title = m[2]?.trim();
      if (url && url.startsWith("http")) {
        citations.push({ url, ...(title ? { title } : {}), rank: rank++ });
      }
    }

    return {
      ok: true,
      answer: {
        answerText: prose,
        citations,
        surfaceId: "line",
        rawInput: { html },
        // nativeReview = true even in the HTML path — Line is always a
        // JP/TW/TH market surface regardless of how the raw data arrived.
        nativeReview: true,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

/** Singleton LineParser instance — stateless, safe to reuse across calls. */
export const lineParser = new LineParser();
