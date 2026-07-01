/**
 * Meta AI scrape parser — DESIGN-phase4.md T09.
 *
 * Input: a raw DOM snapshot (structured object) or HTML string from the
 * RPA runner for meta.ai.
 *
 * PROSE/CITATION SEPARATION invariants (DESIGN-phase4.md):
 *   - answerText contains ONLY the AI-generated prose.
 *   - Citations (source URLs, titles, snippets) go in the citations[] array.
 *   - The judge sees clean prose; brand attribution is faithful.
 *
 * NO_ANSWER: returned (typed value, never thrown) when Meta AI did not
 *   produce an AI-generated answer (e.g. only a search results page).
 *
 * ParseError / DRIFT: returned when the expected DOM/fixture structure has
 *   changed and the parser can no longer locate the answer container.
 *
 * nativeReview: NOT set for Meta AI (global surface, English-first).
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
 * Structured snapshot the RPA runner emits for Meta AI.
 * All fields are optional so the parser degrades gracefully on layout drift.
 */
interface MetaAiSnapshot {
  /** The AI-generated answer prose block extracted by the RPA runner. */
  answerBlock?: string | null;
  /** Citations / source links attached to the answer. */
  citations?: Array<{
    url?: string | null;
    title?: string | null;
    snippet?: string | null;
    rank?: number | null;
  }> | null;
  /** True when the page contained no AI answer. */
  noAnswerFound?: boolean;
  /** Raw HTML of the answer container (alternative to answerBlock). */
  answerHtml?: string | null;
  /** Llama model identifier returned in the response metadata. */
  modelId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSnapshot(raw: unknown): raw is MetaAiSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    "answerBlock" in obj ||
    "citations" in obj ||
    "noAnswerFound" in obj ||
    "answerHtml" in obj ||
    "modelId" in obj
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeProse(text: string): string {
  return text.replace(/\s{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// MetaAiParser
// ---------------------------------------------------------------------------

export class MetaAiParser implements SurfaceParser<unknown> {
  readonly surfaceId = "metaAi" as const;

  parse(raw: unknown): ParseResult {
    // -----------------------------------------------------------------------
    // Branch 1: structured RPA snapshot
    // -----------------------------------------------------------------------
    if (isSnapshot(raw)) {
      return this._parseSnapshot(raw);
    }

    // -----------------------------------------------------------------------
    // Branch 2: raw HTML string fallback
    // -----------------------------------------------------------------------
    if (typeof raw === "string") {
      return this._parseHtml(raw);
    }

    // -----------------------------------------------------------------------
    // Unexpected input type → DRIFT
    // -----------------------------------------------------------------------
    return {
      ok: false,
      code: "DRIFT",
      message:
        "MetaAiParser: unexpected raw input type — expected MetaAiSnapshot object or HTML string",
      rawFragment: typeof raw,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot path
  // -------------------------------------------------------------------------

  private _parseSnapshot(snap: MetaAiSnapshot): ParseResult {
    if (snap.noAnswerFound === true) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Meta AI page returned no AI answer block",
      };
    }

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

    if (prose === null || prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Meta AI snapshot contained no extractable answer prose",
      };
    }

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

    // Build providerMeta to capture Llama model id (advisory, stored as rawInput).
    const rawInputMeta: Record<string, unknown> = { ...snap };

    return {
      ok: true,
      answer: {
        answerText: prose,
        citations,
        surfaceId: "metaAi",
        rawInput: rawInputMeta,
        // nativeReview not set — Meta AI is a global English-first surface.
      },
    };
  }

  // -------------------------------------------------------------------------
  // HTML string path
  // -------------------------------------------------------------------------

  private _parseHtml(html: string): ParseResult {
    // Meta AI HTML markers (as of 2025):
    //   - <div data-testid="ai-response"> ... </div>
    //   - <div class="x1lliihq"> (Llama response container) — less stable
    //   - <div aria-label="Meta AI response"> ... </div>

    const answerMatch =
      html.match(/data-testid="ai-response"[^>]*>([\s\S]*?)<\/div>/i) ??
      html.match(/aria-label="Meta AI response"[^>]*>([\s\S]*?)<\/div>/i);

    if (!answerMatch || !answerMatch[1]) {
      return {
        ok: false,
        code: "DRIFT",
        message:
          "MetaAiParser: could not locate AI answer container in HTML — possible layout drift",
        rawFragment: html.slice(0, 300),
      };
    }

    const prose = normalizeProse(stripHtml(answerMatch[1]));
    if (prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Meta AI HTML answer container was empty",
      };
    }

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
        surfaceId: "metaAi",
        rawInput: { html },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

/** Singleton MetaAiParser instance. */
export const metaAiParser = new MetaAiParser();
