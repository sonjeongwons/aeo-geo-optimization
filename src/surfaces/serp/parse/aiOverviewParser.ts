/**
 * Google AI Overviews — SERP parser.
 *
 * DESIGN-phase4.md T08 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - PROSE/CITATION SEPARATION: answerText contains ONLY prose; all citation
 *     URLs, titles, and snippets go into the `citations` array.  The judge
 *     receives clean prose without URL/title noise.
 *   - NO_ANSWER (typed value, not an exception): returned when Google did not
 *     surface an AI Overview for this query (most queries do not trigger one).
 *     Callers must handle this as a valid measurement outcome.
 *   - NEVER throw: all outcomes are typed return values (ParseResult).
 *   - Unit-testable with fixtures; no live network calls in this module.
 *
 * §12 compliance: Google AI Overviews MUST be fetched via an official SERP API
 * only — never via RPA/raw scraping.  This parser operates on the structured
 * SERP API JSON blob; it has no knowledge of HTTP transports.
 *
 * Expected input shape (ValueSERP / DataForSEO style, narrowed below):
 *   {
 *     ai_overview?: {
 *       text_blocks?: Array<{
 *         type: string;
 *         text?: string;
 *         items?: string[];   // list-block items (structured form from some vendors)
 *       }>;
 *       references?: Array<{ link: string; title?: string; snippet?: string }>;
 *     };
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

interface AioReference {
  link: string;
  title?: string;
  snippet?: string;
}

interface AioBlock {
  type: string;
  text?: string;
  /** Structured list items provided by some SERP API vendors for type==='list' blocks. */
  items?: string[];
}

interface AioShape {
  text_blocks?: AioBlock[];
  references?: AioReference[];
}

interface SerpApiBlob {
  ai_overview?: AioShape;
  // Vendor-specific aliases accepted for forward-compatibility:
  aiOverview?: AioShape;           // camelCase alias (some vendors)
  answer_box?: { answer?: string; snippet?: string }; // DataForSEO fallback
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
 * Locate the ai_overview block regardless of vendor casing.
 * Returns undefined when no AI Overview is present (NO_ANSWER path).
 */
function extractAioBlock(blob: SerpApiBlob): AioShape | undefined {
  return blob.ai_overview ?? blob.aiOverview;
}

/**
 * Flatten a list block into a prose string.
 *
 * SERP API vendors return list blocks in two shapes:
 *   - Structured: `items` is an array of strings (one entry per bullet).
 *   - Flat:       `text` is the raw block text (already bullet-formatted or plain).
 *
 * Both shapes are flattened to "- <item>" lines joined by newlines so the judge
 * receives the list content as readable prose.  Citation URLs are NEVER in the
 * `items` or list `text` — they live in the top-level `references` array only.
 *
 * PROSE/CITATION SEPARATION: this function returns ONLY prose; no citation
 * URLs, titles, or other reference material.
 */
function flattenListBlock(block: AioBlock): string {
  // Prefer the structured items array when the vendor provides it.
  if (isArray(block.items) && block.items.length > 0) {
    const bullets = (block.items as unknown[])
      .filter((item) => isString(item) && (item as string).trim().length > 0)
      .map((item) => `- ${(item as string).trim()}`);
    return bullets.join("\n");
  }
  // Fall back to the text field (may already contain "- " bullets or plain text).
  if (isString(block.text) && block.text.trim().length > 0) {
    return block.text.trim();
  }
  return "";
}

/**
 * Extract prose from text_blocks, joining paragraph AND list blocks.
 *
 * PM-02 fix: list blocks are the DOMINANT format for 'best-X' / 'top-alternatives'
 * recommendation queries (SPEC §14 brand-attribution queries). Discarding them
 * caused list-style AIO answers to reach the judge as empty prose, so the brand
 * was never detected — a measurement defect.
 *
 * Block handling:
 *   'paragraph' / 'text' — included as-is (trimmed prose).
 *   'list'               — flattened to "- <item>" bullets (see flattenListBlock).
 *   'code' / 'image' / other — skipped (not prose; not answer content).
 *
 * PROSE/CITATION SEPARATION is preserved: citation URLs never appear here
 * because they live in the top-level `references` array, not in block text/items.
 *
 * Returns empty string if blocks are absent or all non-prose types.
 */
function extractProse(blocks: AioBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "text") {
      if (isString(block.text) && block.text.trim().length > 0) {
        parts.push(block.text.trim());
      }
    } else if (block.type === "list") {
      const listProse = flattenListBlock(block);
      if (listProse.length > 0) {
        parts.push(listProse);
      }
    }
    // 'code', 'image', 'video', and all other types are intentionally skipped.
  }
  return parts.join("\n\n");
}

/**
 * Extract structured citations from the references array.
 * Citations are NEVER appended to answerText.
 */
function extractCitations(refs: AioReference[]): Citation[] {
  return refs
    .filter((r) => isString(r.link) && r.link.trim().length > 0)
    .map((r, idx) => {
      const citation: Citation = {
        url: r.link.trim(),
        rank: idx + 1,
      };
      if (isString(r.title) && r.title.trim().length > 0) {
        citation.title = r.title.trim();
      }
      if (isString(r.snippet) && r.snippet.trim().length > 0) {
        citation.snippet = r.snippet.trim();
      }
      return citation;
    });
}

// ---------------------------------------------------------------------------
// AiOverviewParser — implements SurfaceParser<unknown>
// ---------------------------------------------------------------------------

export class AiOverviewParser implements SurfaceParser<unknown> {
  readonly surfaceId = "googleAio" as const;

  /**
   * Parse a raw SERP API response blob.
   *
   * Returns:
   *   ParseOk        — AI Overview present; answerText = prose only, citations separate.
   *   ParseNoAnswer  — No AI Overview block for this query (most queries); NOT an error.
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
        message: "aiOverviewParser: raw input is not a JSON object",
        rawFragment: raw,
      };
    }

    const blob = raw as SerpApiBlob;
    const aioBlock = extractAioBlock(blob);

    // No AI Overview present — this is a valid measurement outcome, not an error.
    if (aioBlock === undefined) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "No AI Overview block in SERP API response (query did not trigger AIO)",
      };
    }

    // Validate the ai_overview block is an object.
    if (!isRecord(aioBlock)) {
      return {
        ok: false,
        code: "DRIFT",
        message: "aiOverviewParser: ai_overview is not an object",
        rawFragment: aioBlock,
      };
    }

    // Re-cast to the typed interface after the Record guard.
    const typedAioBlock = aioBlock as AioShape;

    // Extract text blocks.
    // eslint-disable-next-line @typescript-eslint/dot-notation
    const rawBlocks = typedAioBlock['text_blocks'];
    const blocks: AioBlock[] = isArray(rawBlocks)
      ? (rawBlocks as AioBlock[])
      : [];

    // Extract prose (ONLY prose — no citation URLs in here).
    const prose = extractProse(blocks);

    // If text_blocks are present but yield no prose, treat as no meaningful answer.
    // This guards against AIO blocks that contain only images, code, or other
    // non-prose block types that carry no extractable answer text.
    if (prose.length === 0) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "AI Overview present but contains no extractable prose text",
      };
    }

    // Extract citations — separate from prose (§ PROSE/CITATION SEPARATION).
    // eslint-disable-next-line @typescript-eslint/dot-notation
    const rawRefs = typedAioBlock['references'];
    const citations: Citation[] = isArray(rawRefs)
      ? extractCitations(rawRefs as AioReference[])
      : [];

    const answer: SurfaceAnswer = {
      answerText: prose,
      citations,
      surfaceId: this.surfaceId,
      rawInput: raw,
    };

    return { ok: true, answer };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory (mirrors pattern in providers/stub.ts)
// ---------------------------------------------------------------------------

/** Shared parser instance — stateless, safe to reuse across calls. */
export const aiOverviewParser = new AiOverviewParser();
