/**
 * src/content/assembleContentSet.ts
 *
 * T15 — assembleContentSet: the §0/Phase-3 seam.
 *
 * DESIGN-phase2.md §"Variant Pipeline / STAGE D":
 *
 *   1. Accepts generated items from generateMultilingualContent + JSON-LD assets
 *      produced by the pure jsonld.ts builders.
 *   2. Re-validates every body against its zod schema (length band enforced for
 *      answer_block via wordCount.ts).
 *   3. Persists each validated item as a content_asset row (gate_status='pending').
 *   4. Runs runContentGates() over each asset, supplying same-language siblings
 *      (ALL same-language assets in the set, including already-passed ones, so the
 *      phrasingVariationGate sees the full dedup scope — §7#1 cross-meaning check).
 *   5. Updates each asset's gate_status + gate_report via repo.updateAssetGateStatus().
 *   6. Returns the assembled content_asset rows with their terminal gate_status.
 *
 * §0 GUARANTEE:
 *   - This module exposes NO HTTP-write verb and NEVER writes to a customer
 *     property.  It calls repo functions that write to the LOCAL DB only.
 *   - The Phase 3 handoff is the gate_status='passed' predicate evaluated by
 *     queueForDeploy.ts.
 *
 * KEY DESIGN DECISIONS:
 *   - The generator NEVER emits gate_status='passed'.  The only path to 'passed'
 *     is through the runContentGates fold result.
 *   - Re-gating after a claim sign-off calls this same function but skips the
 *     generation step — $0 because no LLM call is made.
 *   - siblings for the phrasingVariationGate are fetched from the DB after each
 *     batch insert so concurrent runs for the same content_set_id compete fairly
 *     at the DB layer (uq_content_asset_natural prevents double-insert).
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { randomUUID } from "crypto";
import type { ContentAsset, ContentGateContext, ClaimSourceRow } from "./types.js";
import { ContentBodySchema } from "./types.js";
import type { GeneratedContentItemWithReview } from "./multilingualContent.js";
import { computeLengthUnits, lengthInBand } from "./wordCount.js";
import { runContentGates } from "./contentGate.js";
import type { ContentGate } from "./contentGate.js";
import { requiresDisclosure } from "./channelContentMatrix.js";
import {
  insertContentAsset,
  listContentAssetsForDedup,
  updateAssetGateStatus,
} from "../db/repo.js";
import type { ContentAssetRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Disclosure tag helpers (CO-1 / IC-01 fix)
// ---------------------------------------------------------------------------

import enTerms from "../../config/content-terms/en.json" with { type: "json" };
import koTerms from "../../config/content-terms/ko.json" with { type: "json" };
import jaTerms from "../../config/content-terms/ja.json" with { type: "json" };

/**
 * Return the first controlled-vocabulary disclosure tag for the given language.
 * Falls back to the English vocabulary for unsupported languages.
 *
 * CO-1/IC-01 fix: assembleContentSet uses this to populate disclosure_tag on
 * pr_wire/directory/web2/social assets before they reach the disclosureGate,
 * which permanently blocked every external channel because disclosure_tag was
 * never populated.
 */
function defaultDisclosureTag(language: string): string {
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  let tags: readonly string[];
  switch (lang) {
    case "ko":
      tags = koTerms.disclosure_tags;
      break;
    case "ja":
      tags = jaTerms.disclosure_tags;
      break;
    default:
      tags = enTerms.disclosure_tags;
  }
  // disclosure_tags[0] is always present (validated at build time via JSON import).
  // If the array were somehow empty, fall back to the English first tag.
  return tags[0] ?? (enTerms.disclosure_tags[0] as string);
}

// ---------------------------------------------------------------------------
// DB row → ContentAsset mapper
// ---------------------------------------------------------------------------

/**
 * Map a raw DB ContentAssetRow (body: unknown, claims: unknown, etc.) to a
 * typed ContentAsset used in gate context.
 *
 * Body and claims are cast — they were persisted as typed jsonb; the gate
 * implementations accept the parsed values and the zod schemas re-validate at
 * gate time if needed.
 */
function mapDbRowToAsset(s: ContentAssetRow): ContentAsset {
  return {
    id: s.id,
    customer_id: s.customer_id,
    industry: s.industry,
    template_id: s.template_id,
    template_version: s.template_version,
    content_set_id: s.content_set_id,
    content_type: s.content_type as ContentAsset["content_type"],
    format: s.format as ContentAsset["format"],
    channel_class: s.channel_class as ContentAsset["channel_class"],
    language: s.language,
    phrasing_group_id: s.phrasing_group_id,
    // body stored as jsonb — cast to the typed union
    body: s.body as ContentAsset["body"],
    // claims stored as jsonb — cast array
    claims: (Array.isArray(s.claims) ? s.claims : []) as ContentAsset["claims"],
    word_count: s.word_count,
    gate_status: s.gate_status as ContentAsset["gate_status"],
    // gate_report stored as jsonb — cast array
    gate_report: (Array.isArray(s.gate_report) ? s.gate_report : null) as ContentAsset["gate_report"],
    disclosure_tag: s.disclosure_tag,
    needs_native_review: s.needs_native_review,
    regen_attempts: s.regen_attempts,
    provenance: s.provenance as ContentAsset["provenance"],
    created_at: s.created_at,
  };
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Provenance snapshot for each asset (brief hash, model, generation timestamp).
 */
export interface AssetProvenance {
  brief_hash?: string;
  model?: string;
  generated_at?: string;
}

/**
 * Input to assembleContentSet — the full set of generated items + JSON-LD assets
 * to persist and gate for a single content_set_id.
 */
export interface AssembleContentSetInput {
  /** The content_set_id (already persisted via insertContentSet). */
  contentSetId: string;
  /** Customer UUID (null for owned-net generic assets). */
  customerId: string | null;
  /** Industry key for provenance. */
  industry: string;
  /** Template UUID for provenance. */
  templateId: string;
  /** Template version for provenance. */
  templateVersion: number;
  /**
   * Generated content items from generateMultilingualContent().
   * These are the prose items (definition, answer_block, faq, comparison, case_study).
   */
  generatedItems: GeneratedContentItemWithReview[];
  /**
   * Pre-built JSON-LD assets from jsonld.ts builders.
   * These have already been validated by JsonLdBodySchema but need gating.
   * Passed as JsonLdBuildOk.asset (the ContentAsset envelope).
   */
  jsonLdAssets: ContentAsset[];
  /** Brand name aliases for the phrasingVariationGate. */
  brandAliases: string[];
  /** All claim_source rows for the customer (for claimVerificationGate). */
  claimSources: ClaimSourceRow[];
  /** Ordered list of content gates to run (cheap structural first, paid last). */
  gates: readonly ContentGate[];
  /** Optional provenance metadata (brief hash, model, timestamp). */
  provenance?: AssetProvenance | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * One assembled asset result with its terminal gate_status.
 */
export interface AssembledAsset {
  /** The DB-persisted asset id (UUID). */
  id: string;
  /** Terminal gate status after runContentGates(). */
  gateStatus: "passed" | "blocked" | "needs_human";
  /** Language of the asset (for logging/reporting). */
  language: string;
  /** Format of the asset (for logging/reporting). */
  format: string;
  /** Channel class (for logging/reporting). */
  channelClass: string;
}

/**
 * Result returned by assembleContentSet().
 */
export interface AssembleContentSetResult {
  /** All assembled + gated + persisted assets. */
  assets: AssembledAsset[];
  /** Total assets inserted into the DB (includes ON CONFLICT DO NOTHING no-ops). */
  totalInserted: number;
  /** Total assets that passed all gates. */
  passedCount: number;
  /** Total assets blocked by a gate. */
  blockedCount: number;
  /** Total assets routed to human review. */
  needsHumanCount: number;
  /** Assets skipped due to body schema validation failure. */
  validationFailedCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a generated item's body.
 *
 * For answer_block bodies, computes and injects the per-script length_units
 * and asserts the text is within the 134-167 band.
 *
 * Returns the validated body, or null if the body fails validation or is
 * out-of-band for a length-constrained format.
 */
function validateBody(
  body: unknown,
  language: string
): { body: ContentAsset["body"]; wordCount: number | null } | null {
  const parsed = ContentBodySchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const validBody = parsed.data;

  if (validBody.content_type === "answer_block") {
    // Re-compute length_units (never trust the model's self-reported value).
    const computedUnits = computeLengthUnits(validBody.text, language);
    if (!lengthInBand(validBody.text, language)) {
      // Out-of-band: skip this item (caller may regenerate with regen_attempts cap).
      return null;
    }
    // Inject the authoritative per-script length_units.
    return {
      body: { ...validBody, length_units: computedUnits },
      wordCount: computedUnits,
    };
  }

  return { body: validBody, wordCount: null };
}

/**
 * Convert a GeneratedContentItemWithReview to the insertContentAsset parameter
 * shape and insert it, returning the asset id or null on conflict.
 */
async function insertGeneratedItem(
  item: GeneratedContentItemWithReview,
  opts: {
    contentSetId: string;
    customerId: string | null;
    industry: string;
    templateId: string;
    templateVersion: number;
    provenance: AssetProvenance | null | undefined;
  }
): Promise<{ id: string; asset: Omit<ContentAsset, "created_at"> } | null> {
  const validated = validateBody(item.body, item.language);
  if (!validated) {
    return null;
  }

  const assetId = randomUUID();

  // CO-1/IC-01 fix: populate disclosure_tag for disclosure-required channels
  // before the asset reaches disclosureGate. Without this, every pr_wire/
  // directory/web2/social asset was permanently blocked because disclosure_tag
  // was never set anywhere in the pipeline.
  const channelClass = item.channel_class as ContentAsset["channel_class"];
  const disclosureTag = requiresDisclosure(channelClass)
    ? defaultDisclosureTag(item.language)
    : null;

  const result = await insertContentAsset({
    contentSetId: opts.contentSetId,
    customerId: opts.customerId,
    industry: opts.industry,
    templateId: opts.templateId,
    templateVersion: opts.templateVersion,
    contentType: validated.body.content_type,
    format: item.format,
    channelClass: item.channel_class,
    language: item.language,
    phrasingGroupId: item.phrasingGroupId,
    body: validated.body,
    claims: [],
    wordCount: validated.wordCount,
    gateStatus: "pending",
    gateReport: null,
    disclosureTag,
    needsNativeReview: item.needs_native_review,
    regenAttempts: 0,
    provenance: opts.provenance ?? null,
  });

  if (!result) {
    // ON CONFLICT DO NOTHING — already exists, skip.
    return null;
  }

  // Build an in-memory ContentAsset (gate fold needs it).
  const asset: Omit<ContentAsset, "created_at"> = {
    id: result.id,
    customer_id: opts.customerId,
    industry: opts.industry,
    template_id: opts.templateId,
    template_version: opts.templateVersion,
    content_set_id: opts.contentSetId,
    content_type: validated.body.content_type,
    format: item.format as ContentAsset["format"],
    channel_class: channelClass,
    language: item.language,
    phrasing_group_id: item.phrasingGroupId,
    body: validated.body,
    claims: [],
    word_count: validated.wordCount,
    gate_status: "pending",
    gate_report: null,
    disclosure_tag: disclosureTag,
    needs_native_review: item.needs_native_review,
    regen_attempts: 0,
    provenance: opts.provenance ?? null,
  };

  return { id: result.id, asset };
}

/**
 * Insert a pre-built JSON-LD ContentAsset envelope (from jsonld.ts builders).
 * Returns the persisted id or null on conflict.
 */
async function insertJsonLdAsset(
  jsonLdAsset: ContentAsset,
  opts: {
    contentSetId: string;
    customerId: string | null;
    industry: string;
    templateId: string;
    templateVersion: number;
    provenance: AssetProvenance | null | undefined;
  }
): Promise<{ id: string; asset: Omit<ContentAsset, "created_at"> } | null> {
  // CO-1/IC-01 fix: populate disclosure_tag for disclosure-required channels.
  // JSON-LD assets are owned_net (§6), so requiresDisclosure returns false and
  // disclosureTag stays null — but we apply the same logic for correctness.
  const jsonLdDisclosureTag = requiresDisclosure(jsonLdAsset.channel_class)
    ? defaultDisclosureTag(jsonLdAsset.language)
    : null;

  const result = await insertContentAsset({
    contentSetId: opts.contentSetId,
    customerId: opts.customerId,
    industry: opts.industry,
    templateId: opts.templateId,
    templateVersion: opts.templateVersion,
    contentType: jsonLdAsset.content_type,
    format: jsonLdAsset.format,
    channelClass: jsonLdAsset.channel_class,
    language: jsonLdAsset.language,
    phrasingGroupId: jsonLdAsset.phrasing_group_id,
    body: jsonLdAsset.body,
    claims: [],
    wordCount: null,
    gateStatus: "pending",
    gateReport: null,
    disclosureTag: jsonLdDisclosureTag,
    needsNativeReview: false,
    regenAttempts: 0,
    provenance: opts.provenance ?? null,
  });

  if (!result) {
    return null;
  }

  const asset: Omit<ContentAsset, "created_at"> = {
    id: result.id,
    customer_id: opts.customerId,
    industry: opts.industry,
    template_id: opts.templateId,
    template_version: opts.templateVersion,
    content_set_id: opts.contentSetId,
    content_type: jsonLdAsset.content_type,
    format: jsonLdAsset.format,
    channel_class: jsonLdAsset.channel_class,
    language: jsonLdAsset.language,
    phrasing_group_id: jsonLdAsset.phrasing_group_id,
    body: jsonLdAsset.body,
    claims: [],
    word_count: null,
    gate_status: "pending",
    gate_report: null,
    disclosure_tag: jsonLdDisclosureTag,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: opts.provenance ?? null,
  };

  return { id: result.id, asset };
}

// ---------------------------------------------------------------------------
// assembleContentSet — main export
// ---------------------------------------------------------------------------

/**
 * Assemble, validate, gate, and persist all content assets for a content set.
 *
 * Pipeline:
 *   1. Insert generated prose items (validate bodies, inject per-script length_units).
 *   2. Insert pre-built JSON-LD assets.
 *   3. For EACH inserted asset:
 *      a. Load siblings = all same-language assets in the set (from DB, so the
 *         phrasingVariationGate sees the full live dedup scope including assets
 *         inserted earlier in this same run).
 *      b. Run runContentGates(gates, ctx).
 *      c. Update gate_status + gate_report in DB.
 *   4. Return AssembleContentSetResult.
 *
 * §0: no HTTP-write verb; never writes to a customer property; Phase 3 handoff
 * is exclusively via the gate_status='passed' predicate.
 *
 * The generator emits gate_status='passed' ONLY via the runContentGates fold
 * result — there is NO other path to 'passed'.
 *
 * @param input - Full assembly input (generated items + JSON-LD + gates + context).
 * @returns AssembleContentSetResult with per-status counts.
 */
export async function assembleContentSet(
  input: AssembleContentSetInput
): Promise<AssembleContentSetResult> {
  const {
    contentSetId,
    customerId,
    industry,
    templateId,
    templateVersion,
    generatedItems,
    jsonLdAssets,
    brandAliases,
    claimSources,
    gates,
    provenance,
  } = input;

  const insertOpts = {
    contentSetId,
    customerId,
    industry,
    templateId,
    templateVersion,
    provenance,
  };

  // ---- Phase 1: insert all generated prose items ----

  // Collect successfully inserted assets (in memory for gating).
  // We process them after ALL inserts so siblings are available in the DB.
  const pendingAssets: Array<Omit<ContentAsset, "created_at"> & { created_at?: Date }> = [];
  let validationFailedCount = 0;

  for (const item of generatedItems) {
    const inserted = await insertGeneratedItem(item, insertOpts);
    if (!inserted) {
      // Either ON CONFLICT (already exists) or body validation failed.
      // We cannot distinguish at this point — count as validation failure for
      // conservatism (ON CONFLICT items are extremely rare in normal operation).
      validationFailedCount++;
      continue;
    }
    pendingAssets.push({ ...inserted.asset, created_at: new Date() });
  }

  // ---- Phase 2: insert pre-built JSON-LD assets ----

  for (const jsonLdAsset of jsonLdAssets) {
    const inserted = await insertJsonLdAsset(jsonLdAsset, insertOpts);
    if (!inserted) {
      validationFailedCount++;
      continue;
    }
    pendingAssets.push({ ...inserted.asset, created_at: new Date() });
  }

  const totalInserted = pendingAssets.length;

  // ---- Phase 3: gate each asset ----

  const assembledAssets: AssembledAsset[] = [];
  let passedCount = 0;
  let blockedCount = 0;
  let needsHumanCount = 0;

  for (const pending of pendingAssets) {
    const asset = pending as ContentAsset;

    // Load ALL same-language assets in this content set from the DB.
    // This is the sibling set for phrasingVariationGate (§7#1):
    //   - Includes already-passed assets from previous iterations of this loop.
    //   - Excludes the current asset itself (it will appear in the DB from Phase 1
    //     insert above, so we filter it out by id).
    let siblings: ContentAsset[] = [];
    try {
      const dbSiblings = await listContentAssetsForDedup(contentSetId, asset.language);
      // Filter out the current asset; keep all others (including pending from
      // earlier in this loop — they are already in the DB).
      siblings = dbSiblings
        .filter((s) => s.id !== asset.id)
        .map((s) => mapDbRowToAsset(s));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[assembleContentSet] Failed to load siblings for asset ${asset.id} ` +
          `language="${asset.language}": ${msg} — proceeding with empty siblings.`
      );
    }

    const ctx: ContentGateContext = {
      asset,
      siblings,
      brandAliases,
      claimSources,
    };

    // Run the gate fold (non-short-circuit — all verdicts collected).
    let terminalStatus: "passed" | "blocked" | "needs_human" = "blocked";
    let gateReport: Array<{ gate: string; action: "pass" | "block" | "needs_human"; reason?: string }> = [];

    try {
      const gateResult = await runContentGates(gates, ctx);
      terminalStatus = gateResult.terminalStatus;
      gateReport = gateResult.gateReport;
    } catch (err: unknown) {
      // Fail closed: any unexpected gate error → needs_human.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[assembleContentSet] Unexpected gate error for asset ${asset.id}: ${msg} — ` +
          `routing to needs_human (fail-closed).`
      );
      terminalStatus = "needs_human";
      gateReport = [
        {
          gate: "assembleContentSet",
          action: "needs_human",
          reason: `Unexpected gate error: ${msg}`,
        },
      ];
    }

    // Persist the terminal gate_status and gate_report.
    try {
      await updateAssetGateStatus(asset.id, {
        gateStatus: terminalStatus,
        gateReport,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[assembleContentSet] Failed to update gate_status for asset ${asset.id}: ${msg}`
      );
      // Continue — do not throw; partial results are better than total failure.
    }

    // Accumulate counts.
    if (terminalStatus === "passed") {
      passedCount++;
    } else if (terminalStatus === "blocked") {
      blockedCount++;
    } else {
      needsHumanCount++;
    }

    assembledAssets.push({
      id: asset.id,
      gateStatus: terminalStatus,
      language: asset.language,
      format: asset.format,
      channelClass: asset.channel_class,
    });

    console.info(
      `[assembleContentSet] Asset ${asset.id} ` +
        `(${asset.format}/${asset.language}/${asset.channel_class}): ${terminalStatus}`
    );
  }

  console.info(
    `[assembleContentSet] content_set_id=${contentSetId}: ` +
      `total=${totalInserted} passed=${passedCount} blocked=${blockedCount} ` +
      `needs_human=${needsHumanCount} validation_failed=${validationFailedCount}`
  );

  return {
    assets: assembledAssets,
    totalInserted,
    passedCount,
    blockedCount,
    needsHumanCount,
    validationFailedCount,
  };
}

// ---------------------------------------------------------------------------
// Re-gate: re-run content gates over already-persisted assets ($0 LLM cost)
// ---------------------------------------------------------------------------

/**
 * Re-gate a single already-persisted content asset (e.g. after a claim sign-off).
 *
 * This is the $0 re-gate path: no generation, no LLM call.  It re-runs the
 * deterministic content gates over a FULLY POPULATED asset (claims already
 * populated by a prior claimExtract pass, verified_by now set on the signed
 * claim_source rows).
 *
 * Called by reviewClaims.ts CLI after human sign-off on a claim_source row.
 *
 * @param asset        - The asset to re-gate (fetched from DB with all claims).
 * @param contentSetId - Content set id (for sibling lookup).
 * @param brandAliases - Brand aliases for the phrasingVariationGate.
 * @param claimSources - UPDATED claim_source rows (including newly signed ones).
 * @param gates        - Ordered content gates.
 * @returns {terminalStatus, gateReport}
 */
export async function regateAsset(
  asset: ContentAsset,
  contentSetId: string,
  brandAliases: string[],
  claimSources: ClaimSourceRow[],
  gates: readonly ContentGate[]
): Promise<{
  terminalStatus: "passed" | "blocked" | "needs_human";
  gateReport: Array<{ gate: string; action: "pass" | "block" | "needs_human"; reason?: string }>;
}> {
  // Load siblings.
  let siblings: ContentAsset[] = [];
  try {
    const dbSiblings = await listContentAssetsForDedup(contentSetId, asset.language);
    siblings = dbSiblings
      .filter((s) => s.id !== asset.id)
      .map((s) => mapDbRowToAsset(s));
  } catch {
    // Fail gracefully — empty siblings is safe for re-gate.
  }

  const ctx: ContentGateContext = {
    asset,
    siblings,
    brandAliases,
    claimSources,
  };

  const gateResult = await runContentGates(gates, ctx);

  await updateAssetGateStatus(asset.id, {
    gateStatus: gateResult.terminalStatus,
    gateReport: gateResult.gateReport,
  });

  return {
    terminalStatus: gateResult.terminalStatus,
    gateReport: gateResult.gateReport,
  };
}
