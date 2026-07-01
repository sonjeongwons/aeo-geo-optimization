/**
 * src/content/gates/selfContainedness.ts
 *
 * Research-driven gate (DESIGN-research-aeo-geo.md rank 3).
 *
 * Retrieval/citation by answer engines happens at the PASSAGE level (Dense X
 * Retrieval EMNLP 2024; Anthropic Contextual Retrieval; patents US12346366B2 /
 * US11481646B2; ~44% of citations come from the first 30% of a page). A passage
 * is only citation-worthy if it stands alone OUT OF CONTEXT: it must name the
 * brand entity and lead with the answer (BLUF), not open with a cross-section
 * pronoun whose referent lives elsewhere.
 *
 * This is an ADVISORY lint: it routes prose assets that fail self-containedness
 * to needs_human (recoverable on human review / regeneration), it does NOT block
 * — to avoid false positives across scripts. Structured formats (faq/comparison/
 * jsonld) are exempt (they are not single liftable prose passages).
 *
 * §7 note: this enforces brand PRESENCE + answer-first STRUCTURE; it never adds
 * a claim. The canonical brand string stays literal (BM25 lexical match) while
 * the phrasingVariation gate handles surrounding-sentence variety — distinct levers.
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";

/** Prose content_types that should be independently liftable passages. */
const PROSE_TYPES = new Set(["definition", "answer_block", "case_study"]);

/** Cross-section pronouns that, as the FIRST word, signal a missing referent. */
const LEAD_PRONOUN =
  /^(?:it|its|it's|they|their|they're|them|this|these|those|that|he|she|his|her)\b/i;

/** Extract the lead prose (first ~160 chars) of a prose asset, or null if N/A. */
function leadOf(asset: ContentAsset): string | null {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;
    case "answer_block":
      return body.text;
    case "case_study":
      return body.situation || body.action || body.result || "";
    default:
      return null; // faq / comparison / jsonld exempt
  }
}

export const selfContainednessGate = {
  name: "selfContainednessGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset, brandAliases } = ctx;
    if (!PROSE_TYPES.has(asset.body.content_type)) {
      return { action: "pass", gate: "selfContainednessGate" };
    }

    const lead = leadOf(asset);
    if (!lead || lead.trim().length === 0) {
      return { action: "pass", gate: "selfContainednessGate" };
    }
    const trimmed = lead.trim();
    const head = trimmed.slice(0, 200).toLowerCase();

    const issues: string[] = [];

    // (1) Brand must appear in the lead (BLUF + entity-named). Only enforce when
    //     we actually have aliases to check against (otherwise skip — no false fail).
    const aliases = (brandAliases ?? []).map((a) => a.toLowerCase().trim()).filter((a) => a.length >= 2);
    if (aliases.length > 0) {
      const named = aliases.some((a) => head.includes(a));
      if (!named) {
        issues.push("lead (first ~200 chars) does not name the brand entity — not self-contained/BLUF");
      }
    }

    // (2) For prose answers, the passage should not OPEN with a cross-section
    //     pronoun whose referent is outside the passage.
    if (asset.body.content_type === "answer_block" || asset.body.content_type === "case_study") {
      if (LEAD_PRONOUN.test(trimmed)) {
        issues.push(`opens with a cross-section pronoun ("${trimmed.split(/\s+/)[0]}") — referent not in passage`);
      }
    }

    if (issues.length > 0) {
      return {
        action: "needs_human",
        gate: "selfContainednessGate",
        reason: issues.join("; "),
      };
    }
    return { action: "pass", gate: "selfContainednessGate" };
  },
};
