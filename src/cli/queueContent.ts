/**
 * src/cli/queueContent.ts
 *
 * T16 — CLI: queue all gate_status='passed' assets in a content_set for Phase 3.
 *
 * Usage:
 *   npm run queue-content -- --set <content-set-uuid>
 *
 * Selects all content_asset rows for the set where gate_status='passed' AND not
 * already in content_deploy_queue, then inserts them into content_deploy_queue.
 *
 * IDEMPOTENT: calling queue-content multiple times for the same set is safe.
 * The uq_deploy_queue_asset UNIQUE index (ON CONFLICT DO NOTHING) prevents
 * duplicate queue rows.
 *
 * §0 OFF-SITE:
 *   This CLI NEVER deploys content or writes to a customer property.
 *   It ONLY inserts rows into content_deploy_queue (the Phase 3 handoff).
 *   Phase 3 owns the transition from 'queued' → deployed.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js";
import { queueForDeploy } from "../content/queueForDeploy.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  setId: string | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let setId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--set" || flag === "-s") && next && !next.startsWith("-")) {
      setId = next;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run queue-content -- --set <content-set-uuid>\n\n" +
          "Options:\n" +
          "  --set, -s   Content set UUID (required)\n" +
          "  --help, -h  Show this help message\n\n" +
          "Queues all gate_status='passed' assets in the content_set for Phase 3 deploy.\n" +
          "Blocked and needs_human assets are structurally excluded (NOT queued).\n" +
          "Idempotent: calling multiple times is safe (no duplicate queue rows).\n\n" +
          "This CLI NEVER deploys content. It ONLY inserts into content_deploy_queue.\n",
      );
      process.exit(0);
    }
  }

  return { setId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { setId } = parseArgs();

  if (!setId) {
    process.stderr.write(
      "queue-content: error — --set <uuid> is required.\n" +
        "Usage: npm run queue-content -- --set <content-set-uuid>\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `[queue-content] Queueing passed assets for content_set=${setId}...\n`,
  );

  const result = await queueForDeploy(setId);

  const output = {
    contentSetId: setId,
    queued: result.queued,
    message:
      result.queued > 0
        ? `${result.queued} asset(s) queued for Phase 3 deploy (status='queued').`
        : "No new assets to queue. All passed assets were already queued (idempotent).",
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[queue-content] Done. contentSetId=${setId} queued=${result.queued}\n`,
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
  _argv1.endsWith("/queueContent.ts") ||
  _argv1.endsWith("\\queueContent.ts") ||
  _argv1.endsWith("/queueContent.js") ||
  _argv1.endsWith("\\queueContent.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`queue-content: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
