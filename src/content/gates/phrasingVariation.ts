/**
 * src/content/gates/phrasingVariation.ts
 *
 * T11 — phrasingVariationGate (§7#1): CJK-safe near-duplicate phrasing check.
 *
 * DESIGN-phase2.md §"THE FIVE GATES":
 *   For a candidate asset, compute max trigramJaccard against ALL OTHER same-
 *   language assets in ctx.siblings (NOT scoped to phrasing_group_id — catches
 *   cross-meaning boilerplate copy-paste).  Cross-language pairs are EXEMPT
 *   (reuse Phase 1 'cross-language dedup NOT applied').  If max >= CONTENT_DUP_THRESHOLD
 *   it BLOCKS.
 *
 *   PR-wire syndication fan-out: copies of the SAME phrasing_group_id on
 *   channel_class='pr_wire' are intentional syndication and are EXEMPT from
 *   §7#1 blocking (they represent reaching multiple outlets with the same release,
 *   not boilerplate copy-paste across meanings).
 *
 * THRESHOLD NOTE (DESIGN-phase2.md):
 *   The inherited 0.65 (question dedup) / asserted 0.8 values are UNTUNED for
 *   134-167-word fact-dense blocks.  Fact-dense content blocks share brand/category
 *   trigrams at high Jaccard scores even when meanings differ.  CONTENT_DUP_THRESHOLD
 *   is set to 0.85 as a conservative starting point tuned for emora/k-beauty
 *   multi-channel fixtures (long blocks).  Operators should adjust this constant
 *   against their specific content corpus.
 *
 * Reuses:
 *   - dedup.ts normalizeText + trigramJaccard (verbatim, CJK-safe)
 *   - channelContentMatrix.ts isPrWireSyndicationCopy
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { normalizeText, trigramJaccard } from "../../generate/dedup.js";
import { isPrWireSyndicationCopy } from "../channelContentMatrix.js";
import type { ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";

// ---------------------------------------------------------------------------
// Configuration constant
// ---------------------------------------------------------------------------

/**
 * CONTENT_DUP_THRESHOLD — max trigramJaccard below which two same-language assets
 * are considered sufficiently distinct.  Assets at or above this score are BLOCKED.
 *
 * This is a single config constant referenced by the gate (acceptance criterion).
 * Tuned on 134-167-word fact-dense emora/k-beauty multi-channel fixtures.
 * Operators should tune this against their specific content corpus before production.
 *
 * Why 0.85 (not 0.65 from question dedup, not 0.8):
 *   - 134-167-word blocks share brand/category trigrams far more than short questions.
 *   - At 0.65 many legitimately distinct long blocks would be blocked (false positives).
 *   - 0.85 catches clear copy-paste / boilerplate while allowing fact-dense siblings
 *     that differ in structure or framing.
 *   - PR-wire exemption means same-phrasing-group PR copies never trigger this.
 */
export const CONTENT_DUP_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Helper: extract text for comparison from a ContentAsset
// ---------------------------------------------------------------------------

/**
 * Get the text representation of a content asset body for near-dup comparison.
 * We use the primary text field of the body; for structured types (faq, comparison,
 * case_study, jsonld) we serialize the key text content.
 *
 * PURE: no I/O.
 */
function extractComparisonText(asset: ContentAsset): string {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;

    case "answer_block":
      return body.text;

    case "faq":
      return body.rows.map((r) => `${r.q} ${r.a}`).join(" ");

    case "comparison": {
      const cols = body.columns.join(" ");
      const rows = body.rows
        .map((r) => `${r.entity} ${r.cells.map((c) => c.value).join(" ")}`)
        .join(" ");
      return `${cols} ${rows}`;
    }

    case "case_study":
      return `${body.situation} ${body.action} ${body.result}`;

    case "jsonld":
      try {
        return JSON.stringify(body.json);
      } catch {
        return "";
      }
  }
}

// ---------------------------------------------------------------------------
// phrasingVariationGate
// ---------------------------------------------------------------------------

/**
 * phrasingVariationGate (§7#1)
 *
 * Blocks an asset whose normalized text is >= CONTENT_DUP_THRESHOLD similar
 * to ANY other same-language asset in the set (cross-language pairs exempt).
 *
 * PR-wire syndication copies of the SAME phrasing_group_id are EXEMPT because
 * they are intentional fan-out (same content to multiple outlets), not §7#1
 * cross-meaning boilerplate copy-paste.
 *
 * This gate is CHEAP (pure Jaccard, no LLM) and runs FIRST in the fold so
 * blocked assets never pay for claim extraction.
 */
export const phrasingVariationGate = {
  name: "phrasingVariationGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset, siblings } = ctx;
    const candidateText = normalizeText(extractComparisonText(asset));

    // Filter siblings: only same-language assets are compared (cross-language exempt).
    const sameLangSiblings = siblings.filter(
      (s) => s.language === asset.language
    );

    let maxSimilarity = 0;
    let mostSimilarId: string | null = null;

    for (const sibling of sameLangSiblings) {
      // PR-wire syndication exemption: same phrasing_group_id is intentional
      // fan-out ONLY when BOTH assets are pr_wire. Cross-channel pairs (e.g.
      // pr_wire vs owned_net/web2) sharing a phrasing_group_id are NOT exempt
      // — they represent §7#1 cross-channel boilerplate duplication.
      if (
        isPrWireSyndicationCopy(
          asset.channel_class,
          asset.phrasing_group_id,
          sibling.phrasing_group_id,
          sibling.channel_class
        )
      ) {
        continue;
      }

      const siblingText = normalizeText(extractComparisonText(sibling));
      const sim = trigramJaccard(candidateText, siblingText);

      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        mostSimilarId = sibling.id;
      }
    }

    if (maxSimilarity >= CONTENT_DUP_THRESHOLD) {
      return {
        action: "block",
        gate: "phrasingVariationGate",
        reason:
          `Asset text is too similar to sibling ${mostSimilarId ?? "unknown"} ` +
          `(trigramJaccard=${maxSimilarity.toFixed(3)} >= CONTENT_DUP_THRESHOLD=${CONTENT_DUP_THRESHOLD}). ` +
          `§7#1: same-language near-duplicate blocked.`,
      };
    }

    return {
      action: "pass",
      gate: "phrasingVariationGate",
    };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};
