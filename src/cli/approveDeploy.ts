/**
 * src/cli/approveDeploy.ts
 *
 * T16 — CLI: human sign-off on queued deploy rows.
 *
 * Usage:
 *   npm run approve-deploy -- --approver <identity> --asset <asset-uuid>
 *   npm run approve-deploy -- --approver <identity> --set <content-set-uuid>
 *
 * Sets approved_by (approver identity) + approved_at on content_deploy_queue
 * rows matching the given asset or content set.
 *
 * §11 고객 승인 / §12 audit trail:
 *   Every queued row is fail-closed NOT eligible until this CLI signs it.
 *   approved_by is a non-null identity string (not a bare boolean).
 *   The identity + timestamp are copied into url_registry.approver_audit
 *   at publish time for §12 compliance.
 *
 * IDEMPOTENT: calling approve-deploy multiple times for the same row is safe.
 * Re-approval updates the approved_by/approved_at (last signer wins).
 *
 * §0: this CLI performs NO deploys and NO outbound writes.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js";
import {
  approveDeployRow,
  listContentAssetsForSet,
  findDeployQueueEntriesForAsset,
} from "../db/repo.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  approver: string | undefined;
  assetId: string | undefined;
  setId: string | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let approver: string | undefined;
  let assetId: string | undefined;
  let setId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--approver" || flag === "-a") && next && !next.startsWith("-")) {
      approver = next;
      i++;
    } else if ((flag === "--asset") && next && !next.startsWith("-")) {
      assetId = next;
      i++;
    } else if ((flag === "--set" || flag === "-s") && next && !next.startsWith("-")) {
      setId = next;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run approve-deploy -- --approver <identity> (--asset <uuid> | --set <uuid>)\n\n" +
          "Options:\n" +
          "  --approver, -a  Approver identity string (required; e.g. email or username)\n" +
          "  --asset         Single asset UUID to approve\n" +
          "  --set, -s       Content set UUID — approve all queued rows in the set\n" +
          "  --help, -h      Show this help message\n\n" +
          "Sets approved_by + approved_at on content_deploy_queue rows, making them\n" +
          "eligible for publish.dispatch to claim and enqueue for Phase 3 publish.\n\n" +
          "§11/§12: approver identity is recorded in url_registry.approver_audit at\n" +
          "publish time for compliance audit. A bare boolean is insufficient.\n\n" +
          "This CLI NEVER publishes content. It only updates approval columns.\n",
      );
      process.exit(0);
    }
  }

  return { approver, assetId, setId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { approver, assetId, setId } = parseArgs();

  if (!approver || approver.trim().length === 0) {
    process.stderr.write(
      "approve-deploy: error — --approver <identity> is required.\n" +
        "Usage: npm run approve-deploy -- --approver <identity> (--asset <uuid> | --set <uuid>)\n",
    );
    process.exit(1);
  }

  if (!assetId && !setId) {
    process.stderr.write(
      "approve-deploy: error — either --asset <uuid> or --set <uuid> is required.\n" +
        "Usage: npm run approve-deploy -- --approver <identity> (--asset <uuid> | --set <uuid>)\n",
    );
    process.exit(1);
  }

  const approverIdentity = approver.trim();

  // ---- Collect asset IDs to approve ----------------------------------------

  let assetIds: string[] = [];

  if (assetId) {
    assetIds = [assetId];
    process.stderr.write(
      `[approve-deploy] Approving asset ${assetId} as '${approverIdentity}'...\n`,
    );
  } else if (setId) {
    process.stderr.write(
      `[approve-deploy] Loading assets for content_set=${setId}...\n`,
    );
    const assetRows = await listContentAssetsForSet(setId);
    if (assetRows.length === 0) {
      process.stderr.write(
        `approve-deploy: no assets found for content_set=${setId}.\n`,
      );
      process.exit(0);
    }
    assetIds = assetRows.map((r) => r.id);
    process.stderr.write(
      `[approve-deploy] Found ${assetIds.length} assets in content_set=${setId}.\n`,
    );
  }

  // ---- Approve each asset --------------------------------------------------

  let totalApproved = 0;
  let totalNotFound = 0;
  const results: Array<{ assetId: string; updated: number }> = [];

  for (const id of assetIds) {
    // Pre-check: ensure there is at least one deploy queue row for this asset.
    const queueEntries = await findDeployQueueEntriesForAsset(id);
    if (queueEntries.length === 0) {
      process.stderr.write(
        `[approve-deploy] Asset ${id}: no deploy queue rows found — skipping (run queue-content first).\n`,
      );
      totalNotFound++;
      results.push({ assetId: id, updated: 0 });
      continue;
    }

    const { updated } = await approveDeployRow(id, approverIdentity);
    totalApproved += updated;
    results.push({ assetId: id, updated });

    if (updated > 0) {
      process.stderr.write(
        `[approve-deploy] Asset ${id}: ${updated} queue row(s) approved by '${approverIdentity}'.\n`,
      );
    } else {
      process.stderr.write(
        `[approve-deploy] Asset ${id}: 0 rows updated (already approved or not in queued/leased status).\n`,
      );
    }
  }

  // ---- Output summary -------------------------------------------------------

  const output = {
    approver: approverIdentity,
    assetId: assetId ?? null,
    contentSetId: setId ?? null,
    totalAssets: assetIds.length,
    totalQueueRowsApproved: totalApproved,
    totalAssetsNotQueued: totalNotFound,
    results,
    message:
      totalApproved > 0
        ? `${totalApproved} queue row(s) approved. Run publish-content --set <setId> to dispatch.`
        : totalNotFound > 0
        ? `No rows approved. ${totalNotFound} asset(s) have no queue rows — run queue-content first.`
        : "No rows updated (rows may already be approved or not in queued/leased status).",
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[approve-deploy] Done. approver='${approverIdentity}' ` +
      `assetsChecked=${assetIds.length} queueRowsApproved=${totalApproved}\n`,
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
  _argv1.endsWith("/approveDeploy.ts") ||
  _argv1.endsWith("\\approveDeploy.ts") ||
  _argv1.endsWith("/approveDeploy.js") ||
  _argv1.endsWith("\\approveDeploy.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`approve-deploy: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
