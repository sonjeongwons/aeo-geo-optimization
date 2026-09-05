/**
 * src/cli/gateContent.ts
 *
 * T16 — CLI: run §7 content gates over all assets in a content_set.
 *
 * Usage:
 *   npm run gate-content -- --set <content-set-uuid>
 *
 * Loads all content_asset rows for the set, re-runs runContentGates() over
 * each, and updates gate_status + gate_report in the DB.
 *
 * This is a $0-LLM re-gate when claim sources have been signed (reviewClaims)
 * and the caller wants to re-evaluate without regenerating content.
 *
 * Re-gate cost: $0 for assets whose cheap structural gates suffice. The paid
 * claimVerificationGate is invoked only for assets not already blocked.
 *
 * §0: no HTTP-write verb; no customer-property writes.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js";
import { env, geminiApiKeys } from "../config/env.js";
import {
  listContentAssetsForSet,
  listContentAssetsForDedup,
  findClaimSources,
  updateAssetGateStatus,
  insertLlmCall,
} from "../db/repo.js";
import { runContentGates } from "../content/contentGate.js";
import { buildProductionContentGateRegistry } from "../content/contentGate.js";
import type { LedgerPort } from "../content/multilingualContent.js";
import { makeGeminiAdapter } from "../providers/gemini.js";
import type { ContentAsset, ContentGateContext, ClaimSourceRow } from "../content/types.js";
import type { ContentAssetRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// DB ledger port (CO-2/IC-02: needed for production gate registry)
// ---------------------------------------------------------------------------

const dbLedger: LedgerPort = {
  insertLlmCall(c) {
    return insertLlmCall(c);
  },
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  setId: string | undefined;
  customer: string | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let setId: string | undefined;
  let customer: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--set" || flag === "-s") && next && !next.startsWith("-")) {
      setId = next;
      i++;
    } else if ((flag === "--customer" || flag === "-c") && next && !next.startsWith("-")) {
      customer = next;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run gate-content -- --set <content-set-uuid> [--customer <uuid>]\n\n" +
          "Options:\n" +
          "  --set, -s      Content set UUID to gate (required)\n" +
          "  --customer, -c Customer UUID (required for loading claim_source registry)\n" +
          "  --help, -h     Show this help message\n\n" +
          "Output:\n" +
          "  JSON summary of gate_status counts after re-gating.\n",
      );
      process.exit(0);
    }
  }

  return { setId, customer };
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
  const { setId, customer } = parseArgs();

  if (!setId) {
    process.stderr.write(
      "gate-content: error — --set <uuid> is required.\n" +
        "Usage: npm run gate-content -- --set <content-set-uuid>\n",
    );
    process.exit(1);
  }

  // ---- Load all assets for this content_set --------------------------------
  process.stderr.write(`[gate-content] Loading assets for content_set=${setId}...\n`);

  const assetRows = await listContentAssetsForSet(setId);
  if (assetRows.length === 0) {
    process.stderr.write(`gate-content: no assets found for content_set=${setId}.\n`);
    process.exit(0);
  }

  process.stderr.write(`[gate-content] Found ${assetRows.length} assets.\n`);

  // ---- Load claim sources --------------------------------------------------
  // Derive customerId from first asset row if not supplied via CLI.
  const customerId = customer ?? assetRows[0]?.customer_id ?? null;

  let claimSources: ClaimSourceRow[] = [];
  if (customerId) {
    // Cast from DB row (claim_kind: string) to typed ClaimSourceRow (literal union).
    const rawSources = await findClaimSources(customerId);
    claimSources = rawSources as ClaimSourceRow[];
    process.stderr.write(
      `[gate-content] Loaded ${claimSources.length} claim_source rows for customer=${customerId}.\n`,
    );
  } else {
    process.stderr.write(
      "[gate-content] WARNING: no customer_id — claim_source registry empty; claim gates will route to needs_human.\n",
    );
  }

  // ---- Derive brand aliases from assets (store in provenance) --------------
  const brandAliases: string[] = [];

  // ---- CO-2/IC-02: Build production gate registry with REAL Gemini adapter --
  // gateContent is the CLI path for re-gating assets after claim sign-off.
  // Using defaultContentGateRegistry (no-adapter) meant the §7#7 claim
  // extraction pass never ran, so every claims-bearing asset was permanently
  // routed to needs_human instead of being verifiable to 'passed'.
  const apiKeys = geminiApiKeys();
  if (apiKeys.length === 0) {
    process.stderr.write(
      "[gate-content] WARNING: GEMINI_API_KEY is not set — " +
        "claimVerificationGate will fail closed (needs_human) for claims-bearing assets.\n",
    );
  }
  const geminiAdapter = makeGeminiAdapter(apiKeys);
  const productionGateRegistry = buildProductionContentGateRegistry({
    adapter: geminiAdapter,
    ledger: dbLedger,
    customerId: customerId ?? null,
    // No per-run budget for gateContent: re-gating after sign-off should not be
    // blocked by a fresh ceiling (sign-off is human-triggered, low-frequency).
  });

  // ---- Gate each asset (non-short-circuit fold per runContentGates) --------
  const gates = productionGateRegistry.gates();
  let passedCount = 0;
  let blockedCount = 0;
  let needsHumanCount = 0;

  for (const row of assetRows) {
    const asset = mapDbRowToAsset(row);

    // Load same-language siblings for phrasingVariationGate.
    let siblings: ContentAsset[] = [];
    try {
      const siblingRows = await listContentAssetsForDedup(setId, asset.language);
      siblings = siblingRows
        .filter((s) => s.id !== asset.id)
        .map((s) => mapDbRowToAsset(s));
    } catch {
      // Fail gracefully — empty siblings is safe (gate will not block).
    }

    const ctx: ContentGateContext = {
      asset,
      siblings,
      brandAliases,
      claimSources,
    };

    let terminalStatus: "passed" | "blocked" | "needs_human" = "needs_human";
    let gateReport: Array<{ gate: string; action: "pass" | "block" | "needs_human"; reason?: string }> = [];

    try {
      const result = await runContentGates(gates, ctx);
      terminalStatus = result.terminalStatus;
      gateReport = result.gateReport;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[gate-content] Unexpected error gating asset ${asset.id}: ${msg} — routing needs_human.\n`,
      );
      gateReport = [{ gate: "gateContent", action: "needs_human", reason: msg }];
    }

    // Persist updated gate_status + gate_report.
    try {
      await updateAssetGateStatus(asset.id, {
        gateStatus: terminalStatus,
        gateReport,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gate-content] Failed to update asset ${asset.id}: ${msg}\n`);
    }

    if (terminalStatus === "passed") passedCount++;
    else if (terminalStatus === "blocked") blockedCount++;
    else needsHumanCount++;

    process.stderr.write(
      `[gate-content] Asset ${asset.id} (${asset.format}/${asset.language}): ${terminalStatus}\n`,
    );
  }

  // ---- Output summary -------------------------------------------------------
  const output = {
    contentSetId: setId,
    total: assetRows.length,
    passedCount,
    blockedCount,
    needsHumanCount,
    message:
      passedCount > 0
        ? `${passedCount} asset(s) passed. Run queue-content --set ${setId} to queue for Phase 3.`
        : needsHumanCount > 0
        ? `${needsHumanCount} asset(s) need human review. Run review-claims --set ${setId}.`
        : "All assets blocked. Review gate_report for §7 violations.",
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[gate-content] Done. contentSetId=${setId} ` +
      `passed=${passedCount} blocked=${blockedCount} needs_human=${needsHumanCount}\n`,
  );
}

// ---------------------------------------------------------------------------
// ESM main-module guard
// ---------------------------------------------------------------------------

const _selfUrl = import.meta.url;
const _selfPath = fileURLToPath(_selfUrl);
const _argv1 = process.argv[1] ?? "";

const _isCli =
  _argv1 === _selfPath ||
  _argv1.endsWith("/gateContent.ts") ||
  _argv1.endsWith("\\gateContent.ts") ||
  _argv1.endsWith("/gateContent.js") ||
  _argv1.endsWith("\\gateContent.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`gate-content: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
