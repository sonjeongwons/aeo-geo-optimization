/**
 * Copilot scrape parser — DESIGN-phase4.md T09.
 *
 * Input: a raw DOM snapshot (string) or structured snapshot object from the
 * RPA runner. In the stub/fixture path the RPA runner provides a plain object
 * with known keys; in the live path it would be an HTML string.
 *
 * PROSE/CITATION SEPARATION invariants (DESIGN-phase4.md):
 *   - answerText contains ONLY the AI-generated prose.
 *   - Citations (source URLs, titles, snippets) go in the citations[] array.
 *   - The judge sees clean prose; brand attribution is faithful.
 *
 * NO_ANSWER: returned (typed value, never thrown) when Copilot did not produce
 *   an AI-generated answer block (e.g. only web results are present).
 *
 * ParseError / DRIFT: returned when the expected DOM/fixture structure has
 *   changed and the parser can no longer locate the answer container.
 *
 * nativeReview: NOT set for Copilot (English-first global surface).
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
 * The structured snapshot shape the RPA runner emits for Copilot.
 * All fields are optional so the parser degrades gracefully when the
 * live layout drifts.
 *
 * In the raw-HTML path `raw` is a string; the parser branches on typeof.
 */
interface CopilotSnapshot {
  /** The AI-generated answer prose block. */
  answerBlock?: string | null;
  /** Source citations attached to the answer. */
  citations?: Array<{
    url?: string | null;
    title?: string | null;
    snippet?: string | null;
    rank?: number | null;
  }> | null;
  /** True when the page rendered no AI answer (only web search results). */
  noAnswerFound?: boolean;
  /** Raw HTML of the answer container (alternative to answerBlock). */
  answerHtml?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether raw is a CopilotSnapshot structured object.
 * We check for the presence of any known key (duck-typing).
 */
function isSnapshot(raw: unknown): raw is CopilotSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    "answerBlock" in obj ||
    "citations" in obj ||
    "noAnswerFound" in obj ||
    "answerHtml" in obj
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
// CopilotParser
// ---------------------------------------------------------------------------

export class CopilotParser implements SurfaceParser<unknown> {
  readonly surfaceId = "copilot" as const;

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
    // Unexpected input type → DRIFT (parser can't handle this shape)
    // -----------------------------------------------------------------------
    return {
      ok: false,
      code: "DRIFT",
      message:
        "CopilotParser: unexpected raw input type — expected CopilotSnapshot object or HTML string",
      rawFragment: typeof raw,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot path
  // -------------------------------------------------------------------------

  private _parseSnapshot(snap: CopilotSnapshot): ParseResult {
    // Explicit no-answer signal from RPA runner.
    if (snap.noAnswerFound === true) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Copilot page returned no AI answer block (only web results)",
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
        reason: "Copilot snapshot contained no extractable answer prose",
      };
    }

    // Build citations list (separate from prose — invariant).
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
        surfaceId: "copilot",
        rawInput: snap,
        // nativeReview not set — Copilot is a global English-first surface.
      },
    };
  }

  // -------------------------------------------------------------------------
  // HTML string path
  // -------------------------------------------------------------------------

  private _parseHtml(html: string): ParseResult {
    // Heuristic: look for Copilot's AI-answer container marker.
    // The actual selector used by the live RPA runner is a runtime concern;
    // here we parse a best-effort extraction from an HTML string fixture.
    //
    // Known Copilot HTML markers (as of 2025):
    //   - <div data-testid="answer-section"> ... </div>
    //   - <div class="ac-textBlock"> ... </div>
    //
    // The parser looks for these markers and extracts their text content.

    const answerMatch =
      html.match(
        /data-testid="answer-section"[^>]*>([\s\S]*?)<\/div>/i
      ) ??
      html.match(/class="[^"]*ac-textBlock[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (!answerMatch || !answerMatch[1]) {
      // No recognizable answer container → DRIFT (layout changed).
      // We return DRIFT here (not NO_ANSWER) because the HTML structure itself
      // is unexpected, indicating a layout change the parser needs to handle.
      return {
        ok: false,
        code: "DRIFT",
        message:
          "CopilotParser: could not locate AI answer container in HTML — possible layout drift",
        rawFragment: html.slice(0, 300),
      };
    }

    const prose = normalizeProse(stripHtml(answerMatch[1]));
    if (prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Copilot HTML answer container was empty",
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
        surfaceId: "copilot",
        rawInput: { html },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

/** Singleton CopilotParser instance. */
export const copilotParser = new CopilotParser();
