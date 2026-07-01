/**
 * src/cli/reviewClaims.ts
 *
 * T16 — CLI: human sign-off on needs_human claim_source rows, then re-gate ($0).
 *
 * Usage:
 *   npm run review-claims -- --set <content-set-uuid> --by <email>
 *                            [--claim-id <uuid>] [--list-only]
 *
 * Actions:
 *   (default) List all needs_human assets for the set, then prompt for sign-off
 *   on unsigned claim_source rows referenced by those assets.
 *
 *   --list-only     Just list needs_human assets and unsigned claims; do not sign.
 *   --claim-id <id> Sign a specific claim_source row by its UUID.
 *
 * Sign-off flow:
 *   1. List all assets with gate_status='needs_human' in the content_set.
 *   2. For each such asset, show the gate_report and the claims[] on the asset.
 *   3. Human provides --claim-id <uuid> --by <email> to sign a specific claim.
 *   4. signClaimSource(id, verifiedBy) stamps verified_by + verified_at.
 *   5. Re-gate the asset (regateAsset from assembleContentSet.ts) — $0 LLM call.
 *   6. If re-gate produces 'passed', the asset is selectable by queueContent.
 *
 * RE-GATE IS $0:
 *   No LLM call is made during re-gate; runContentGates() is pure/deterministic
 *   for the cheap structural gates. The claimVerificationGate's deterministic
 *   decision is re-run against the UPDATED claim_source registry (now signed).
 *
 * §0: no HTTP-write verb; no customer-property writes.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js";
import {
  listContentAssetsForSet,
  findClaimSources,
  signClaimSource,
} from "../db/repo.js";
import { regateAsset } from "../content/assembleContentSet.js";
import { defaultContentGateRegistry } from "../content/contentGate.js";
import type { ContentAsset, ClaimSourceRow } from "../content/types.js";
import type { ContentAssetRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  setId: string | undefined;
  by: string | undefined;
  claimId: string | undefined;
  listOnly: boolean;
  customer: string | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let setId: string | undefined;
  let by: string | undefined;
  let claimId: string | undefined;
  let listOnly = false;
  let customer: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--set" || flag === "-s") && next && !next.startsWith("-")) {
      setId = next;
      i++;
    } else if ((flag === "--by" || flag === "-b") && next && !next.startsWith("-")) {
      by = next;
      i++;
    } else if (flag === "--claim-id" && next && !next.startsWith("-")) {
      claimId = next;
      i++;
    } else if (flag === "--list-only" || flag === "-l") {
      listOnly = true;
    } else if ((flag === "--customer" || flag === "-c") && next && !next.startsWith("-")) {
      customer = next;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run review-claims -- --set <content-set-uuid> --by <email>\n" +
          "                               [--claim-id <uuid>] [--list-only]\n\n" +
          "Options:\n" +
          "  --set, -s      Content set UUID (required)\n" +
          "  --by, -b       Reviewer email (required for sign-off)\n" +
          "  --claim-id     Specific claim_source UUID to sign off\n" +
          "  --list-only    List needs_human assets without signing\n" +
          "  --customer, -c Customer UUID (for claim_source registry lookup)\n" +
          "  --help, -h     Show this help message\n\n" +
          "Sign-off flow:\n" +
          "  1. List needs_human assets and their claim_source rows.\n" +
          "  2. Run with --claim-id <uuid> --by <email> to sign a specific claim.\n" +
          "  3. Signed claims trigger a $0 re-gate of affected assets.\n" +
          "  4. Passed assets become quenable via queue-content.\n",
      );
      process.exit(0);
    }
  }

  return { setId, by, claimId, listOnly, customer };
}

// ---------------------------------------------------------------------------
// DB row → ContentAsset mapper
// ---------------------------------------------------------------------------

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
    body: s.body as ContentAsset["body"],
    claims: (Array.isArray(s.claims) ? s.claims : []) as ContentAsset["claims"],
    word_count: s.word_count,
    gate_status: s.gate_status as ContentAsset["gate_status"],
    gate_report: (Array.isArray(s.gate_report) ? s.gate_report : null) as ContentAsset["gate_report"],
    disclosure_tag: s.disclosure_tag,
    needs_native_review: s.needs_native_review,
    regen_attempts: s.regen_attempts,
    provenance: s.provenance as ContentAsset["provenance"],
    created_at: s.created_at,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { setId, by, claimId, listOnly, customer } = parseArgs();

  if (!setId) {
    process.stderr.write(
      "review-claims: error — --set <uuid> is required.\n" +
        "Usage: npm run review-claims -- --set <content-set-uuid> --by <email>\n",
    );
    process.exit(1);
  }

  // ---- Load all assets for this content_set --------------------------------
  process.stderr.write(`[review-claims] Loading assets for content_set=${setId}...\n`);

  const allRows = await listContentAssetsForSet(setId);
  const needsHumanRows = allRows.filter((r) => r.gate_status === "needs_human");

  if (needsHumanRows.length === 0) {
    process.stdout.write(
      JSON.stringify(
        {
          contentSetId: setId,
          needsHumanCount: 0,
          message: "No needs_human assets found. Nothing to review.",
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }

  process.stderr.write(
    `[review-claims] Found ${needsHumanRows.length} needs_human asset(s) ` +
      `(${allRows.length} total).\n`,
  );

  // ---- Derive customerId ---------------------------------------------------
  const customerId = customer ?? needsHumanRows[0]?.customer_id ?? null;

  // ---- Load claim sources --------------------------------------------------
  // Cast from DB row (claim_kind: string) to typed ClaimSourceRow (literal union).
  let claimSources: ClaimSourceRow[] = [];
  if (customerId) {
    const rawSources = await findClaimSources(customerId);
    claimSources = rawSources as ClaimSourceRow[];
  }

  // ---- List mode: just print needs_human assets and unsigned claims --------
  if (listOnly || (!claimId && !by)) {
    const unsigned = claimSources.filter((cs) => cs.verified_by === null);

    const listing = needsHumanRows.map((row) => {
      const asset = mapDbRowToAsset(row);
      return {
        assetId: asset.id,
        format: asset.format,
        language: asset.language,
        channelClass: asset.channel_class,
        gate_report: asset.gate_report,
        claims: asset.claims,
      };
    });

    const output = {
      contentSetId: setId,
      needsHumanCount: needsHumanRows.length,
      unsignedClaimSourceCount: unsigned.length,
      assets: listing,
      unsignedClaimSources: unsigned.map((cs) => ({
        id: cs.id,
        claim_text: cs.claim_text,
        claim_kind: cs.claim_kind,
        source_kind: cs.source_kind,
        verified_by: cs.verified_by,
      })),
      nextStep:
        unsigned.length > 0
          ? `Sign a claim: npm run review-claims -- --set ${setId} --claim-id <uuid> --by <email>`
          : "All claim sources are signed. Re-gate: npm run gate-content -- --set " + setId,
    };

    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    process.exit(0);
  }

  // ---- Sign a specific claim_source row ------------------------------------
  if (claimId && by) {
    process.stderr.write(
      `[review-claims] Signing claim_source id=${claimId} by=${by}...\n`,
    );

    try {
      await signClaimSource(claimId, by);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`review-claims: sign failed: ${msg}\n`);
      process.exit(1);
    }

    process.stderr.write(
      `[review-claims] Claim signed. Refreshing claim_source registry...\n`,
    );

    // Reload claim sources (now with the signed row).
    // Cast from DB row (claim_kind: string) to typed ClaimSourceRow (literal union).
    const updatedClaimSourcesRaw = customerId ? await findClaimSources(customerId) : claimSources;
    const updatedClaimSources: ClaimSourceRow[] = updatedClaimSourcesRaw as ClaimSourceRow[];

    // Re-gate all needs_human assets — $0 LLM call.
    process.stderr.write(
      `[review-claims] Re-gating ${needsHumanRows.length} needs_human asset(s) ($0 — no LLM)...\n`,
    );

    const gates = defaultContentGateRegistry.gates();
    const reGateResults: Array<{
      assetId: string;
      before: string;
      after: string;
    }> = [];

    let newPassedCount = 0;
    let stillNeedsHumanCount = 0;
    let newBlockedCount = 0;

    for (const row of needsHumanRows) {
      const asset = mapDbRowToAsset(row);

      try {
        const result = await regateAsset(
          asset,
          setId,
          [], // brandAliases — could be improved with brief snapshot; safe empty for regate
          updatedClaimSources,
          gates,
        );

        reGateResults.push({
          assetId: asset.id,
          before: "needs_human",
          after: result.terminalStatus,
        });

        if (result.terminalStatus === "passed") newPassedCount++;
        else if (result.terminalStatus === "blocked") newBlockedCount++;
        else stillNeedsHumanCount++;

        process.stderr.write(
          `[review-claims] Asset ${asset.id} (${asset.format}/${asset.language}): ` +
            `needs_human -> ${result.terminalStatus}\n`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[review-claims] Re-gate error for asset ${asset.id}: ${msg}\n`,
        );
        reGateResults.push({
          assetId: asset.id,
          before: "needs_human",
          after: "needs_human",
        });
        stillNeedsHumanCount++;
      }
    }

    const output = {
      contentSetId: setId,
      claimSourceSigned: claimId,
      signedBy: by,
      reGateResults,
      newPassedCount,
      stillNeedsHumanCount,
      newBlockedCount,
      llmCallsMade: 0, // $0 re-gate
      message:
        newPassedCount > 0
          ? `${newPassedCount} asset(s) now passed. Run queue-content --set ${setId} to queue.`
          : stillNeedsHumanCount > 0
          ? `${stillNeedsHumanCount} asset(s) still need_human. Sign more claims.`
          : "All assets resolved (some may now be blocked).",
    };

    process.stdout.write(JSON.stringify(output, null, 2) + "\n");

    process.stderr.write(
      `[review-claims] Done. signed=${claimId} new_passed=${newPassedCount} ` +
        `still_needs_human=${stillNeedsHumanCount} new_blocked=${newBlockedCount} ` +
        `llm_calls=0\n`,
    );
    return;
  }

  // ---- Neither --claim-id+--by nor --list-only: show usage -----------------
  if (!by) {
    process.stderr.write(
      "review-claims: error — --by <email> is required for sign-off.\n" +
        "Use --list-only to list without signing.\n",
    );
    process.exit(1);
  }

  if (!claimId) {
    process.stderr.write(
      "review-claims: error — --claim-id <uuid> is required for sign-off.\n" +
        "Use --list-only to see available claim source UUIDs.\n",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// ESM main-module guard
// ---------------------------------------------------------------------------

const _selfUrl = import.meta.url;
const _selfPath = fileURLToPath(_selfUrl);
const _argv1 = process.argv[1] ?? "";

const _isCli =
  _argv1 === _selfPath ||
  _argv1.endsWith("/reviewClaims.ts") ||
  _argv1.endsWith("\\reviewClaims.ts") ||
  _argv1.endsWith("/reviewClaims.js") ||
  _argv1.endsWith("\\reviewClaims.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`review-claims: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
