/**
 * src/deploy/connectors/prWire.ts
 *
 * T08 — PR Wire channel connector STUB.
 *
 * Automation grade: §8 P1 (auto) — will syndicate one press release to many
 * outlets via a paid PR-wire API (e.g. PR Newswire, GlobeNewswire).
 *
 * TODAY: status:'stub' — no PR-wire API key exists. publish() returns
 * NOT_CONFIGURED. The connector flips to 'ready' when a sanctioned key
 * is added and publish() is implemented; the ChannelConnector interface
 * does NOT change.
 *
 * Key characteristics (documented, not enforced until keyed):
 *   - reversible: false — once a release is syndicated there is no retraction
 *     API across all outlets. Do NOT promise reversibility.
 *   - capabilities: ['publish'] — no update/unpublish (irreversible channel).
 *   - Fan-out (one release → many outlet URLs) is OUT OF SCOPE for the
 *     (asset_id, channel_class) idempotency arbiter; child syndication URLs
 *     will be modeled in a separate syndication-children table, NOT by relaxing
 *     the primary unique.
 *   - Throttle treats the fan-out as ONE publish event (§7#5).
 *
 * §0: publishedUrl must NEVER be the customer domain.
 * §7#3: no community/review connector — structural exclusion.
 * §7#6: disclosure_tag required (external channel); dispatched only when non-null.
 * §8: PR-wire is P1 (highest priority automated channel).
 * §12: no key, no scraping; stub until sanctioned key + human review.
 *
 * DESIGN-phase3.md §"External Channels (stubs)".
 */

import { NOT_CONFIGURED } from "../connector.js";
import type {
  ChannelConnector,
  ChannelCapability,
  PublishRequest,
  PublishResult,
} from "../connector.js";

// ---------------------------------------------------------------------------
// PrWireConnector
// ---------------------------------------------------------------------------

/**
 * PR Wire stub connector.
 *
 * status:'stub' — publish() always returns NOT_CONFIGURED.
 * Will flip to 'ready' once a sanctioned PR-wire API key is wired in.
 */
class PrWireConnector implements ChannelConnector {
  readonly channelClass = "pr_wire" as const;

  /**
   * PR wire only supports publish; no update or unpublish (irreversible channel).
   * confirmIndexing is NOT supported — child outlet URLs are not under our control.
   */
  readonly capabilities: ChannelCapability[] = ["publish"];

  /**
   * 'stub' — no PR-wire API key available in v1-a phase.
   * Rows in content_deploy_queue for this channel stay 'queued' at dispatch
   * (the dispatcher skips non-'ready' connectors; recoverable when key arrives).
   */
  readonly status = "stub" as const;

  /**
   * NOT_CONFIGURED — this connector is a stub.
   *
   * The dispatch layer skips stub channels, so this path is normally unreachable.
   * When reached (e.g. direct test call), returns the typed NOT_CONFIGURED sentinel
   * so orchestration layers can treat it identically to other unconfigured adapters.
   *
   * reversible: false when eventually implemented — PR syndication is irreversible.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Singleton export (mirrors providers/stub.ts pattern)
// ---------------------------------------------------------------------------

/** Singleton PR Wire stub connector — status:'stub', publish→NOT_CONFIGURED. */
export const prWireConnector: ChannelConnector = new PrWireConnector();
