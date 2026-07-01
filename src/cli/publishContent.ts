/**
 * src/cli/publishContent.ts
 *
 * T16 — CLI: manual publish dispatch pass.
 *
 * Usage:
 *   npm run publish-content                        # dry-run (default, safe)
 *   npm run publish-content -- --execute           # real publish
 *   npm run publish-content -- --channel owned_net # single channel
 *   npm run publish-content -- --execute --channel owned_net
 *
 * Manually triggers the publish.dispatch handler, which:
 *   1. Reaps stale leases.
 *   2. For each 'ready' channel (registry.readiness()), computes throttle budget
 *      and claims a batch from content_deploy_queue.
 *   3. Enqueues one publish.unit job per claimed row (via pg-boss).
 *
 * DRY-RUN (default true):
 *   Without --execute, dryRun=true is passed to every publish.unit job.
 *   Dry-run runs the full pipeline (eligibility + throttle + connector in dry mode),
 *   logs plannedUrl, writes a url_registry row with publish_status='dry_run', but
 *   performs no real connector side effects and consumes no real throttle budget.
 *
 * --execute is the mandatory flag to flip DEPLOY_DRY_RUN=false for real publishes.
 *
 * §0: this CLI delegates all §0 enforcement to the OwnedNetConnector + publishUnit.
 * §7#5 throttle: enforced transactionally inside claimNextDeployBatch.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js";
import { env } from "../config/env.js";
import { handlePublishDispatch } from "../deploy/dispatch.js";
import { buildConnectorRegistry } from "../deploy/registry.js";
import { makeOwnedNetConnector } from "../deploy/connectors/ownedNet.js";
import { prWireConnector } from "../deploy/connectors/prWire.js";
import { directoryConnector } from "../deploy/connectors/directory.js";
import { web2Connector } from "../deploy/connectors/web2.js";
import { socialConnector } from "../deploy/connectors/social.js";
import { entityConnector } from "../deploy/connectors/entity.js";
import { PgBossJobQueue } from "../scheduler/queue.js";
import type { ChannelClass } from "../scheduler/jobs.js";
import { CHANNEL_CLASSES } from "../scheduler/jobs.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  execute: boolean;
  channelClass: ChannelClass | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let execute = false;
  let channelClass: ChannelClass | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if (flag === "--execute" || flag === "-x") {
      execute = true;
    } else if ((flag === "--channel" || flag === "-c") && next && !next.startsWith("-")) {
      if (!CHANNEL_CLASSES.includes(next as ChannelClass)) {
        process.stderr.write(
          `publish-content: error — unknown channel class '${next}'.\n` +
            `Valid channels: ${CHANNEL_CLASSES.join(", ")}\n`,
        );
        process.exit(1);
      }
      channelClass = next as ChannelClass;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run publish-content [--execute] [--channel <class>]\n\n" +
          "Options:\n" +
          "  --execute, -x    Perform real publishes (default: dry-run only)\n" +
          "  --channel, -c    Restrict to a single channel class\n" +
          "                   Valid: " + CHANNEL_CLASSES.join(", ") + "\n" +
          "  --help, -h       Show this help message\n\n" +
          "Triggers the publish.dispatch pipeline:\n" +
          "  1. Reaps stale leases.\n" +
          "  2. For each 'ready' channel, claims eligible approved queue rows.\n" +
          "  3. Enqueues publish.unit jobs (processed by the worker).\n\n" +
          "DRY-RUN (default):\n" +
          "  Without --execute, connectors run in dry-run mode — no real writes,\n" +
          "  no throttle budget consumed. A url_registry 'dry_run' row is written.\n\n" +
          "REAL PUBLISH:\n" +
          "  --execute is required to flip dryRun=false. Rows must be approved\n" +
          "  via approve-deploy before they are eligible for dispatch.\n\n" +
          "§0: off-site enforcement lives in OwnedNetConnector + publishUnit.\n",
      );
      process.exit(0);
    }
  }

  return { execute, channelClass };
}

// ---------------------------------------------------------------------------
// Build connector registry
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
  const { execute, channelClass } = parseArgs();

  // --execute flips dryRun=false; otherwise dry-run (safe default).
  const dryRun = !execute;

  process.stderr.write(
    `[publish-content] Starting dispatch: dryRun=${dryRun}` +
      (channelClass ? ` channel=${channelClass}` : " channel=all") +
      "\n",
  );

  if (dryRun) {
    process.stderr.write(
      "[publish-content] DRY-RUN mode — no real publishes will occur.\n" +
        "[publish-content] Pass --execute to perform real publishes.\n",
    );
  } else {
    process.stderr.write(
      "[publish-content] EXECUTE mode — real publishes will be performed.\n",
    );
  }

  // ---- Build the connector registry ----------------------------------------
  const registry = buildRegistry();

  // ---- Start the job queue (pg-boss connects + creates queues) --------------
  const queue = new PgBossJobQueue(env.DATABASE_URL);
  await queue.start();

  try {
    // ---- Run the dispatch handler --------------------------------------------
    const dispatchPayload = {
      channelClass,
      dryRun,
    };

    await handlePublishDispatch(dispatchPayload, queue, registry);

    process.stderr.write(
      `[publish-content] Dispatch complete: dryRun=${dryRun}` +
        (channelClass ? ` channel=${channelClass}` : " channel=all") +
        "\n",
    );

    // ---- Report readiness summary -------------------------------------------
    const readiness = registry.readiness();
    const output = {
      dryRun,
      channelClass: channelClass ?? null,
      registryReadiness: readiness.map((r) => ({
        channelClass: r.channelClass,
        status: r.status,
        capabilities: r.capabilities,
      })),
      message: dryRun
        ? "Dry-run dispatch complete. No real publishes performed. Pass --execute for real publish."
        : "Dispatch complete. publish.unit jobs enqueued for worker processing.",
    };

    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } finally {
    await queue.stop();
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
  _argv1.endsWith("/publishContent.ts") ||
  _argv1.endsWith("\\publishContent.ts") ||
  _argv1.endsWith("/publishContent.js") ||
  _argv1.endsWith("\\publishContent.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`publish-content: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
