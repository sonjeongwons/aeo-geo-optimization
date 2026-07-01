/**
 * src/cli/deployStatus.ts
 *
 * T16 — CLI: deploy status report.
 *
 * Usage:
 *   npm run deploy-status
 *   npm run deploy-status -- --customer <customer-uuid>
 *   npm run deploy-status -- --since <ISO-date>
 *
 * READ-ONLY: prints the connector registry readiness summary, plus
 * url_registry rows (published + indexing status) and a per-channel summary.
 *
 * §3 FEEDBACK — STRICTLY READ-ONLY:
 *   This CLI performs NO writes. It reads url_registry via
 *   listPublishedUrlsForMonitoring (the Phase 3 read-only monitoring surface).
 *   Phase 3 ONLY writes url_registry; the full monitoring consumer is Phase 4.
 *
 * Mirrors existing CLI structure (queueContent.ts / gateContent.ts).
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js";
import { env } from "../config/env.js";
import { listPublishedUrlsForMonitoring } from "../db/repo.js";
import { buildConnectorRegistry } from "../deploy/registry.js";
import { makeOwnedNetConnector } from "../deploy/connectors/ownedNet.js";
import { prWireConnector } from "../deploy/connectors/prWire.js";
import { directoryConnector } from "../deploy/connectors/directory.js";
import { web2Connector } from "../deploy/connectors/web2.js";
import { socialConnector } from "../deploy/connectors/social.js";
import { entityConnector } from "../deploy/connectors/entity.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  customerId: string | undefined;
  since: Date | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let customerId: string | undefined;
  let since: Date | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--customer" || flag === "-c") && next && !next.startsWith("-")) {
      customerId = next;
      i++;
    } else if ((flag === "--since") && next && !next.startsWith("-")) {
      const d = new Date(next);
      if (isNaN(d.getTime())) {
        process.stderr.write(
          `deploy-status: error — invalid --since date '${next}'. Use ISO-8601 format.\n`,
        );
        process.exit(1);
      }
      since = d;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run deploy-status [--customer <uuid>] [--since <ISO-date>]\n\n" +
          "Options:\n" +
          "  --customer, -c  Filter by customer UUID\n" +
          "  --since         Filter published_at >= date (ISO-8601)\n" +
          "  --help, -h      Show this help message\n\n" +
          "Prints:\n" +
          "  1. Connector registry readiness (owned_net=ready, externals=stub)\n" +
          "  2. url_registry rows (published assets + indexing status)\n" +
          "  3. Per-channel publish summary counts\n\n" +
          "READ-ONLY: this CLI performs no writes.\n" +
          "§3 FEEDBACK: Phase 3 write path. Full monitoring consumer is Phase 4.\n",
      );
      process.exit(0);
    }
  }

  return { customerId, since };
}

// ---------------------------------------------------------------------------
// Build connector registry (read-only use for readiness report)
// ---------------------------------------------------------------------------

function buildRegistry() {
  const ownedNetConnector = makeOwnedNetConnector(
    env.OWNED_NET_OUT_DIR,
    env.OWNED_NET_HUB_BASE_URL,
    env.CUSTOMER_DOMAIN_BLOCKLIST,
  );

  return buildConnectorRegistry([
    ownedNetConnector,
    prWireConnector,
    directoryConnector,
    web2Connector,
    socialConnector,
    entityConnector,
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { customerId, since } = parseArgs();

  process.stderr.write("[deploy-status] Gathering deploy status...\n");

  // ---- 1. Connector registry readiness -------------------------------------
  const registry = buildRegistry();
  const readiness = registry.readiness();

  // ---- 2. Published url_registry rows (read-only) --------------------------
  // listPublishedUrlsForMonitoring is the §3 FEEDBACK read-only path.
  // Phase 3 ONLY writes; this read is for status reporting.
  const registryRows = await listPublishedUrlsForMonitoring(customerId, since);

  // ---- 3. Per-channel summary -----------------------------------------------
  const channelSummary: Record<string, {
    published: number;
    indexing: Record<string, number>;
  }> = {};

  for (const row of registryRows) {
    const ch = row.channel_class;
    if (!channelSummary[ch]) {
      channelSummary[ch] = { published: 0, indexing: {} };
    }
    channelSummary[ch].published++;

    const idxStatus = row.indexing_status;
    channelSummary[ch].indexing[idxStatus] =
      (channelSummary[ch].indexing[idxStatus] ?? 0) + 1;
  }

  // ---- 4. Output -----------------------------------------------------------
  const output = {
    generatedAt: new Date().toISOString(),
    filters: {
      customerId: customerId ?? null,
      since: since?.toISOString() ?? null,
    },
    connectorReadiness: readiness.map((r) => ({
      channelClass: r.channelClass,
      status: r.status,
      capabilities: r.capabilities,
    })),
    publishedCount: registryRows.length,
    channelSummary,
    publishedUrls: registryRows.map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      customerId: row.customer_id,
      channelClass: row.channel_class,
      publishedUrl: row.published_url,
      language: row.language,
      publishStatus: row.publish_status,
      indexingStatus: row.indexing_status,
      firstSeenIndexedAt: row.first_seen_indexed_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
      disclosureTag: row.disclosure_tag,
    })),
    notes: [
      "owned_net FsTarget: local file only, not crawlable. indexing_status='submitted' at most.",
      "indexing_status='indexed' requires Phase 4 SERP/Indexing API (out of scope here).",
      "External channels (pr_wire/directory/web2/social/entity) are status:stub — no API keys.",
      "Phase 3 feedback is write-only here; full monitoring loop is Phase 4.",
    ],
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[deploy-status] Done. publishedCount=${registryRows.length} ` +
      `readyChannels=${readiness.filter((r) => r.status === "ready").length}/${readiness.length}\n`,
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
  _argv1.endsWith("/deployStatus.ts") ||
  _argv1.endsWith("\\deployStatus.ts") ||
  _argv1.endsWith("/deployStatus.js") ||
  _argv1.endsWith("\\deployStatus.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`deploy-status: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
