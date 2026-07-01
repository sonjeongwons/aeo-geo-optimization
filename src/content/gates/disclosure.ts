/**
 * src/content/gates/disclosure.ts
 *
 * T11 — disclosureGate (§7#6): STRUCTURAL sponsorship/affiliation disclosure check.
 *
 * DESIGN-phase2.md §"THE FIVE GATES":
 *   STRUCTURAL: channel_class in {pr_wire, directory, web2, social} MUST carry
 *   a non-null disclosure_tag from a controlled vocabulary in the asset's language;
 *   missing/empty = block.
 *
 * §7#6: "공개 — 스폰서·제휴 게재 표시" — sponsorship/affiliation content must
 * be disclosed.  The controlled vocabulary is loaded from
 * config/content-terms/<lang>.json disclosure_tags[].
 *
 * Gate logic:
 * 1. If channel_class is NOT in {pr_wire, directory, web2, social} → pass
 *    (owned_net and entity do not require disclosure).
 * 2. If asset.disclosure_tag is null or empty string → BLOCK.
 * 3. If asset.disclosure_tag is not in the controlled vocabulary for the asset's
 *    language → BLOCK (prevents custom/unauthorized disclosure strings).
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import enTerms from "../../../config/content-terms/en.json" with { type: "json" };
import koTerms from "../../../config/content-terms/ko.json" with { type: "json" };
import jaTerms from "../../../config/content-terms/ja.json" with { type: "json" };
import { requiresDisclosure } from "../channelContentMatrix.js";
import type { ContentGateContext, ContentGateResult } from "../types.js";

// ---------------------------------------------------------------------------
// Controlled vocabulary lookup
// ---------------------------------------------------------------------------

/**
 * Get the controlled disclosure_tags vocabulary for a given language.
 * Falls back to English vocabulary for unsupported languages.
 */
function getDisclosureTags(language: string): readonly string[] {
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  switch (lang) {
    case "ko":
      return koTerms.disclosure_tags;
    case "ja":
      return jaTerms.disclosure_tags;
    default:
      return enTerms.disclosure_tags;
  }
}

// ---------------------------------------------------------------------------
// disclosureGate
// ---------------------------------------------------------------------------

/**
 * disclosureGate (§7#6)
 *
 * STRUCTURAL gate — no LLM, no I/O.
 *
 * Blocks assets on pr_wire/directory/web2/social that:
 * - have a null disclosure_tag, OR
 * - have an empty string disclosure_tag, OR
 * - have a disclosure_tag NOT in the controlled vocabulary for their language.
 *
 * This ensures only pre-approved, legally compliant disclosure strings are used
 * (표시광고법/FTC compliance).
 */
export const disclosureGate = {
  name: "disclosureGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset } = ctx;

    // Step 1: Does this channel require disclosure?
    if (!requiresDisclosure(asset.channel_class)) {
      // owned_net and entity do not require disclosure
      return { action: "pass", gate: "disclosureGate" };
    }

    // Step 2: disclosure_tag must be present and non-empty
    if (asset.disclosure_tag === null || asset.disclosure_tag.trim() === "") {
      return {
        action: "block",
        gate: "disclosureGate",
        reason:
          `Channel class '${asset.channel_class}' requires a disclosure tag ` +
          `(§7#6) but asset.disclosure_tag is null or empty. ` +
          `Use one of the controlled vocabulary tags for language '${asset.language}'.`,
      };
    }

    // Step 3: disclosure_tag must be from the controlled vocabulary
    const allowedTags = getDisclosureTags(asset.language);
    const tagLower = asset.disclosure_tag.trim().toLowerCase();
    const inVocab = allowedTags.some(
      (t) => t.toLowerCase() === tagLower
    );

    if (!inVocab) {
      return {
        action: "block",
        gate: "disclosureGate",
        reason:
          `disclosure_tag "${asset.disclosure_tag}" is not in the controlled ` +
          `vocabulary for language '${asset.language}'. ` +
          `Allowed tags: [${allowedTags.map((t) => `"${t}"`).join(", ")}]. ` +
          `§7#6: only pre-approved disclosure strings are permitted.`,
      };
    }

    return { action: "pass", gate: "disclosureGate" };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};
