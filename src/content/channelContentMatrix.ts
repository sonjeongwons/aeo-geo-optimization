/**
 * src/content/channelContentMatrix.ts
 *
 * T05 — Channel-content matrix (PURE, no IO).
 *
 * Legal format × channel_class combinations, disclosure requirements, and
 * PR-wire syndication fan-out descriptor.
 *
 * Key rules enforced here (structural §7 constraints):
 *
 * 1. JSON-LD formats (jsonld_org, jsonld_faqpage, jsonld_article) are ONLY
 *    legal on owned_net. §6 "구조화 데이터는 자체망에".
 *
 * 2. comparison_table is NOT legal on social — social copy must be
 *    self-contained and conversational.
 *
 * 3. pr_wire, directory, web2, and social channel classes require a disclosure
 *    tag (§7#6 — sponsorship/affiliation disclosure).
 *
 * 4. PR-wire syndication fan-out: a single PR-wire submission produces copies
 *    across multiple syndicated outlets. These are modeled as DISTINCT
 *    channel_class='pr_wire' rows (same content_set_id, same phrasing_group_id,
 *    different syndication_outlet). The phrasingVariationGate must NOT collapse
 *    identical PR-wire copies as duplicates — they represent intentional
 *    syndication fan-out, not §7#1 phrasing-variation violations.
 *
 * References:
 *   DESIGN-phase2.md §"Content Model", §"§7 Guardrail Gates"
 *   SPEC.md §6, §7, §8
 *   phase2-tasks.json T05
 */

import type { ChannelClass, ContentFormat } from "./types.js";

// ---------------------------------------------------------------------------
// Legal format × channel_class matrix
// ---------------------------------------------------------------------------

/**
 * Describes the legality and constraints of a format on a channel class.
 */
export interface ChannelFormatEntry {
  /** Whether this format is legal on this channel class. */
  legal: boolean;
  /** Human-readable note explaining any restriction. */
  note?: string;
}

/**
 * CHANNEL_CONTENT_MATRIX[format][channel_class] → ChannelFormatEntry
 *
 * Formats not listed for a channel class are implicitly illegal.
 * All combinations are enumerated explicitly for auditability.
 */
export const CHANNEL_CONTENT_MATRIX: Record<
  ContentFormat,
  Partial<Record<ChannelClass, ChannelFormatEntry>>
> = {
  // definition_sentence: short definitional phrase; legal on all channel classes.
  definition_sentence: {
    owned_net: { legal: true },
    pr_wire:   { legal: true },
    directory: { legal: true },
    web2:      { legal: true },
    social:    { legal: true },
    entity:    { legal: true },
  },

  // answer_block: 134-167 word self-contained answer; legal on most channels.
  // Not ideal on entity (Wikidata/Crunchbase prefer structured data) but allowed.
  answer_block: {
    owned_net: { legal: true },
    pr_wire:   { legal: true },
    directory: { legal: true },
    web2:      { legal: true },
    social:    { legal: true },
    entity:    { legal: true },
  },

  // faq_table: Q&A structure; not suitable for social (too long/tabular).
  faq_table: {
    owned_net: { legal: true },
    pr_wire:   { legal: true },
    directory: { legal: true },
    web2:      { legal: true },
    social:    { legal: false, note: "FAQ tables are too long/structured for social copy" },
    entity:    { legal: false, note: "Entity profiles (Wikidata/Crunchbase) do not support FAQ tables" },
  },

  // comparison_table: AI-extractable comparison; NOT on social (§ design rule).
  comparison_table: {
    owned_net: { legal: true },
    pr_wire:   { legal: true },
    directory: { legal: true },
    web2:      { legal: true },
    social:    { legal: false, note: "Comparison tables not allowed on social — requires self-contained copy" },
    entity:    { legal: false, note: "Entity profiles do not support comparison tables" },
  },

  // case_study: narrative + metrics; legal on most channels.
  case_study: {
    owned_net: { legal: true },
    pr_wire:   { legal: true },
    directory: { legal: true },
    web2:      { legal: true },
    social:    { legal: true },
    entity:    { legal: false, note: "Entity profiles do not support case study format" },
  },

  // jsonld_org: Organization JSON-LD; ONLY owned_net (§6, §0).
  jsonld_org: {
    owned_net: { legal: true },
    pr_wire:   { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    directory: { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    web2:      { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    social:    { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    entity:    { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
  },

  // jsonld_faqpage: FAQPage JSON-LD; ONLY owned_net (§6, §0).
  jsonld_faqpage: {
    owned_net: { legal: true },
    pr_wire:   { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    directory: { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    web2:      { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    social:    { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    entity:    { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
  },

  // jsonld_article: Article JSON-LD; ONLY owned_net (§6, §0).
  jsonld_article: {
    owned_net: { legal: true },
    pr_wire:   { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    directory: { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    web2:      { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    social:    { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
    entity:    { legal: false, note: "JSON-LD structured data only allowed on owned_net (§6)" },
  },
};

// ---------------------------------------------------------------------------
// Public query API
// ---------------------------------------------------------------------------

/**
 * Returns true if the given format is legal on the given channel class.
 *
 * @param format        - Content format.
 * @param channel_class - Target channel class.
 */
export function isFormatLegalOnChannel(
  format: ContentFormat,
  channel_class: ChannelClass
): boolean {
  const entry = CHANNEL_CONTENT_MATRIX[format]?.[channel_class];
  return entry?.legal === true;
}

/**
 * Returns all legal channel classes for a given format.
 */
export function legalChannelsForFormat(format: ContentFormat): ChannelClass[] {
  const row = CHANNEL_CONTENT_MATRIX[format];
  if (!row) return [];
  return (Object.entries(row) as [ChannelClass, ChannelFormatEntry][])
    .filter(([, entry]) => entry.legal)
    .map(([ch]) => ch);
}

/**
 * Returns all legal formats for a given channel class.
 */
export function legalFormatsForChannel(channel_class: ChannelClass): ContentFormat[] {
  return (Object.keys(CHANNEL_CONTENT_MATRIX) as ContentFormat[]).filter((fmt) =>
    isFormatLegalOnChannel(fmt, channel_class)
  );
}

// ---------------------------------------------------------------------------
// Disclosure requirements (§7#6)
// ---------------------------------------------------------------------------

/**
 * Channel classes that REQUIRE a disclosure tag (§7#6 — sponsorship/affiliation).
 *
 * pr_wire: PR release syndicated to media outlets — disclosure required.
 * directory: Directory listings with sponsored/promoted placement — disclosure required.
 * web2: Medium/dev.to/Hashnode/Brunch etc. — disclosure required for brand content.
 * social: LinkedIn/X — disclosure required for promoted/brand posts.
 *
 * owned_net and entity do NOT require disclosure (owned platform / factual entity record).
 */
const DISCLOSURE_REQUIRED_CHANNELS = new Set<ChannelClass>([
  "pr_wire",
  "directory",
  "web2",
  "social",
]);

/**
 * Returns true if the given channel class requires a disclosure tag.
 *
 * @param channel_class - Target channel class.
 */
export function requiresDisclosure(channel_class: ChannelClass): boolean {
  return DISCLOSURE_REQUIRED_CHANNELS.has(channel_class);
}

// ---------------------------------------------------------------------------
// PR-wire syndication fan-out descriptor
// ---------------------------------------------------------------------------

/**
 * PR-wire syndication outlet descriptor.
 * A single PR-wire submission syndicates to multiple outlets.
 * Each outlet is modeled as a DISTINCT content_deploy_queue row so that
 * identical copy across outlets is NOT collapsed into one channel_class row
 * for dedup purposes — these are intentional syndication copies, not §7#1
 * phrasing-variation violations.
 */
export interface PrWireSyndicationOutlet {
  /** Logical outlet identifier (e.g. 'globenewswire', 'prnewswire', 'businesswire'). */
  outlet_id: string;
  /** Display name for the outlet. */
  outlet_name: string;
  /**
   * Whether this outlet accepts a single submission that auto-syndicates
   * (true) or requires a separate API/submission per outlet (false).
   */
  auto_syndicated: boolean;
}

/**
 * Standard PR-wire syndication fan-out: the known outlets a PR-wire release
 * typically reaches through one submission.
 *
 * This list drives the generation of DISTINCT channel_class='pr_wire' rows per
 * outlet so the phrasingVariationGate can correctly exempt them from §7#1
 * near-dup blocking (same content, distinct distribution targets).
 *
 * NOTE: This is a STATIC descriptor for Phase 2 modeling. Phase 3 will have the
 * live connector registry. Update this list when Phase 3 connectors are built.
 */
export const PR_WIRE_SYNDICATION_OUTLETS: PrWireSyndicationOutlet[] = [
  {
    outlet_id: "globenewswire",
    outlet_name: "GlobeNewswire",
    auto_syndicated: true,
  },
  {
    outlet_id: "prnewswire",
    outlet_name: "PR Newswire",
    auto_syndicated: true,
  },
  {
    outlet_id: "businesswire",
    outlet_name: "Business Wire",
    auto_syndicated: true,
  },
  {
    outlet_id: "accessnewswire",
    outlet_name: "Access Newswire",
    auto_syndicated: true,
  },
  {
    outlet_id: "einpresswire",
    outlet_name: "EIN Presswire",
    auto_syndicated: true,
  },
];

/**
 * Returns true if an asset is a PR-wire syndication copy (and thus exempt from
 * §7#1 phrasing-variation dedup blocking against other PR-wire copies of the
 * same phrasing_group_id).
 *
 * The phrasingVariationGate uses this to distinguish intentional fan-out from
 * cross-meaning boilerplate copy-paste.
 *
 * IMPORTANT: The exemption applies ONLY when BOTH the candidate AND the sibling
 * are channel_class==='pr_wire'. A pr_wire candidate paired with a non-pr_wire
 * sibling (e.g. owned_net, web2) sharing the same phrasing_group_id is NOT
 * exempt — that is cross-channel boilerplate duplication, which §7#1 must flag.
 *
 * @param channel_class         - Candidate asset channel class.
 * @param phrasing_group_id     - Candidate asset phrasing group.
 * @param sibling_phrasing_group_id - Sibling phrasing group.
 * @param sibling_channel_class - Sibling asset channel class. When omitted,
 *   defaults to 'pr_wire' for backward compatibility with call sites that have
 *   not yet been updated to pass the sibling's channel class. Callers SHOULD
 *   always supply this argument to get correct §7#1 cross-channel detection.
 */
export function isPrWireSyndicationCopy(
  channel_class: ChannelClass,
  phrasing_group_id: string,
  sibling_phrasing_group_id: string,
  sibling_channel_class: ChannelClass = "pr_wire"
): boolean {
  // Both candidate AND sibling must be pr_wire for the syndication fan-out
  // exemption to apply. A pr_wire vs non-pr_wire pair sharing a
  // phrasing_group_id is cross-channel boilerplate — §7#1 must block it.
  return (
    channel_class === "pr_wire" &&
    sibling_channel_class === "pr_wire" &&
    phrasing_group_id === sibling_phrasing_group_id
  );
}
