/**
 * Naver AI Answer — SERP parser.
 *
 * DESIGN-phase4.md T08 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - PROSE/CITATION SEPARATION: answerText contains ONLY prose; all citation
 *     URLs, titles, and snippets go into the `citations` array.  The judge
 *     receives clean prose without URL/title noise.
 *   - NO_ANSWER (typed value, not an exception): returned when Naver did not
 *     surface an AI Answer for this query.  Valid measurement outcome.
 *   - NEVER throw: all outcomes are typed return values (ParseResult).
 *   - Unit-testable with fixtures; no live network calls in this module.
 *   - nativeReview=true: Naver is a Korean-market surface; the advisory flag
 *     is set so downstream can queue answers for native-speaker review.
 *     SMR measurement is IDENTICAL whether the flag is on or off.
 *
 * §12 compliance: Naver AI answers MUST be fetched via an official SERP API
 * only — never via RPA/raw scraping.  This parser operates on the structured
 * SERP API JSON blob; it has no knowledge of HTTP transports.
 *
 * Expected input shape (Naver SERP API / ValueSERP style):
 *   {
 *     naver_ai?: {                        // top-level AI answer block
 *       answer?: string;                  // prose text (primary field)
 *       description?: string;            // alias for answer
 *       text_blocks?: Array<{            // structured blocks (some vendors)
 *         type: string;
 *         text?: string;
 *         items?: string[];             // list block structured items
 *       }>;
 *       sources?: Array<{
 *         link: string;
 *         title?: string;
 *         description?: string;
 *       }>;
 *     };
 *     // Alias observed in some vendor integrations:
 *     ai_answer?: { ... };               // same shape
 *   }
 *
 * The parser is deliberately lenient: extra fields are ignored, missing fields
 * fall back to NO_ANSWER.  Any unexpected structural change returns ParseError
 * (DRIFT) so the monitoring layer can alert on parser staleness.
 */

import { NO_ANSWER } from "../../types.js";
import type {
  Citation,
  ParseResult,
  SurfaceAnswer,
  SurfaceParser,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Internal type guards — narrow the unknown SERP API blob safely
// ---------------------------------------------------------------------------

interface NaverSource {
  link: string;
  title?: string;
  description?: string;
  snippet?: string;
}

interface NaverTextBlock {
  type: string;
  text?: string;
  /** Structured list items provided by some SERP API vendors for type==='list' blocks. */
  items?: string[];
}

interface NaverAiShape {
  answer?: string;
  description?: string;  // alias for answer in some API variants
  text?: string;         // another observed alias
  /**
   * Structured text blocks (some Naver SERP API vendors mirror the Google AIO
   * text_blocks shape). Includes 'paragraph', 'text', and 'list' block types.
   * When present alongside flat string fields, text_blocks takes precedence
   * because it carries structured list content that flat fields would not.
   */
  text_blocks?: NaverTextBlock[];
  sources?: NaverSource[];
  references?: NaverSource[];  // alias for sources
}

interface NaverSerpBlob {
  naver_ai?: NaverAiShape;
  ai_answer?: NaverAiShape;    // alias used by some SERP API vendors
  naverAi?: NaverAiShape;      // camelCase alias
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * Locate the Naver AI answer block regardless of vendor key name.
 * Returns undefined when no AI Answer block is present (NO_ANSWER path).
 */
function extractNaverAiBlock(blob: NaverSerpBlob): NaverAiShape | undefined {
  return blob.naver_ai ?? blob.ai_answer ?? blob.naverAi;
}

/**
 * Flatten a Naver list block into prose text using "- <item>" bullets.
 *
 * Vendors may provide list blocks in two shapes:
 *   - Structured: `items` is an array of strings.
 *   - Flat:       `text` is the raw block text.
 *
 * PROSE/CITATION SEPARATION: this function returns ONLY prose; citation URLs
 * live in `sources`/`references`, not in block text/items.
 */
function flattenNaverListBlock(block: NaverTextBlock): string {
  if (isArray(block.items) && block.items.length > 0) {
    const bullets = (block.items as unknown[])
      .filter((item) => isString(item) && (item as string).trim().length > 0)
      .map((item) => `- ${(item as string).trim()}`);
    return bullets.join("\n");
  }
  if (isString(block.text) && block.text.trim().length > 0) {
    return block.text.trim();
  }
  return "";
}

/**
 * Extract prose from the Naver AI block.
 *
 * Priority order:
 *   1. text_blocks array (structured blocks from some SERP API vendors) — handles
 *      both 'paragraph'/'text' blocks and 'list' blocks (PM-02 parity fix for
 *      Naver: list-style answers must not reach the judge as empty prose).
 *   2. Flat string fields: answer > description > text (legacy shape).
 *
 * Returns empty string if no prose can be extracted.
 *
 * PROSE/CITATION SEPARATION: this function returns ONLY prose text.
 * No citation URLs, titles, or other reference material must appear here.
 */
function extractNaverProse(block: NaverAiShape): string {
  // 1. Prefer structured text_blocks when present (carries list content too).
  if (isArray(block.text_blocks) && block.text_blocks.length > 0) {
    const parts: string[] = [];
    for (const tb of block.text_blocks as NaverTextBlock[]) {
      if (tb.type === "paragraph" || tb.type === "text") {
        if (isString(tb.text) && tb.text.trim().length > 0) {
          parts.push(tb.text.trim());
        }
      } else if (tb.type === "list") {
        const listProse = flattenNaverListBlock(tb);
        if (listProse.length > 0) {
          parts.push(listProse);
        }
      }
      // Other block types (code, image, etc.) are skipped.
    }
    if (parts.length > 0) {
      return parts.join("\n\n");
    }
    // text_blocks present but yielded no prose — fall through to flat fields.
  }

  // 2. Fall back to flat string fields (legacy Naver API shape).
  const candidates = [block.answer, block.description, block.text];
  for (const candidate of candidates) {
    if (isString(candidate) && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

/**
 * Extract structured citations from the sources/references array.
 * Citations are NEVER appended to answerText.
 */
function extractNaverCitations(sources: NaverSource[]): Citation[] {
  return sources
    .filter((s) => isString(s.link) && s.link.trim().length > 0)
    .map((s, idx) => {
      const citation: Citation = {
        url: s.link.trim(),
        rank: idx + 1,
      };
      if (isString(s.title) && s.title.trim().length > 0) {
        citation.title = s.title.trim();
      }
      // Prefer `snippet` over `description` for the excerpt field.
      const excerpt = s.snippet ?? s.description;
      if (isString(excerpt) && excerpt.trim().length > 0) {
        citation.snippet = excerpt.trim();
      }
      return citation;
    });
}

// ---------------------------------------------------------------------------
// NaverParser — implements SurfaceParser<unknown>
// ---------------------------------------------------------------------------

export class NaverParser implements SurfaceParser<unknown> {
  readonly surfaceId = "naverAi" as const;

  /**
   * Parse a raw SERP API response blob for a Naver AI answer.
   *
   * Returns:
   *   ParseOk        — AI Answer present; answerText = prose only, citations separate.
   *                    nativeReview=true (KR market language advisory flag).
   *   ParseNoAnswer  — No Naver AI Answer for this query; NOT an error.
   *   ParseError     — Unexpected structural anomaly (drift alert).
   *
   * NEVER throws.
   */
  parse(raw: unknown): ParseResult {
    // Structural guard: we expect a JSON object.
    if (!isRecord(raw)) {
      return {
        ok: false,
        code: "SCHEMA_ERROR",
        message: "naverParser: raw input is not a JSON object",
        rawFragment: raw,
      };
    }

    const blob = raw as NaverSerpBlob;
    const aiBlock = extractNaverAiBlock(blob);

    // No Naver AI Answer present — valid measurement outcome, not an error.
    if (aiBlock === undefined) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "No Naver AI Answer block in SERP API response (query did not trigger AI answer)",
      };
    }

    // Validate the ai block is an object.
    if (!isRecord(aiBlock)) {
      return {
        ok: false,
        code: "DRIFT",
        message: "naverParser: naver_ai/ai_answer is not an object",
        rawFragment: aiBlock,
      };
    }

    // Re-cast to the typed interface after the Record guard so that
    // noPropertyAccessFromIndexSignature does not require bracket notation.
    const typedAiBlock = aiBlock as NaverAiShape;

    // Extract prose (ONLY prose — no citation URLs in here).
    const prose = extractNaverProse(typedAiBlock);

    // If the block yields no prose, treat as no meaningful answer.
    if (prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "Naver AI Answer block present but contains no extractable prose text",
      };
    }

    // Extract citations — separate from prose (PROSE/CITATION SEPARATION invariant).
    // eslint-disable-next-line @typescript-eslint/dot-notation
    const rawSources = typedAiBlock['sources'] ?? typedAiBlock['references'];
    const citations: Citation[] = isArray(rawSources)
      ? extractNaverCitations(rawSources as NaverSource[])
      : [];

    const answer: SurfaceAnswer = {
      answerText: prose,
      citations,
      surfaceId: this.surfaceId,
      rawInput: raw,
      // Naver is a KR-market surface; flag for native-speaker review (advisory only).
      // SMR measurement is IDENTICAL whether this flag is on or off.
      nativeReview: true,
    };

    return { ok: true, answer };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory (mirrors pattern in providers/stub.ts)
// ---------------------------------------------------------------------------

/** Shared parser instance — stateless, safe to reuse across calls. */
export const naverParser = new NaverParser();
