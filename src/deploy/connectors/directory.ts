/**
 * src/deploy/connectors/directory.ts
 *
 * T08 — Directory channel connector STUB.
 *
 * Automation grade: §8 P2 (반자동 / semi-automated) — even when keyed,
 * publish() returns a NEEDS_HUMAN_SUBMIT draft handle rather than submitting
 * automatically. Respects ToS and §11 HumanOps. Actual submission by a human
 * operator.
 *
 * TODAY: status:'stub' — no directory API key exists. publish() returns
 * NOT_CONFIGURED. The connector flips to 'ready' (with requiresHumanSubmit
 * semantics) when a sanctioned key and human-ops workflow arrive; the
 * ChannelConnector interface does NOT change.
 *
 * Key characteristics (documented, not enforced until keyed):
 *   - requiresHumanSubmit: true — even when keyed, publish() creates a draft
 *     handle and returns NEEDS_HUMAN_SUBMIT; it never auto-submits (§8/§11).
 *   - capabilities: ['publish'] — no update (directories rarely support edits
 *     without human sign-off), no unpublish (directory listings are not
 *     generally retractable by API).
 *   - reversible: false — cannot guarantee retraction across all directory outlets.
 *   - requiresHumanSubmit channels stay 'queued' (awaiting connector + human ops);
 *     no human-task table is built in Phase 3.
 *
 * §0: publishedUrl must NEVER be the customer domain.
 * §7#3: no community/review connector — structural exclusion.
 * §7#6: disclosure_tag required (external channel).
 * §8: directory is P2 (semi-automated, human submit required).
 * §11: 고객 승인 / human ops — never auto-fire.
 * §12: ToS respected — no auto-submit until sanctioned key + human review.
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
// DirectoryConnector
// ---------------------------------------------------------------------------

/**
 * Directory stub connector.
 *
 * status:'stub' — publish() always returns NOT_CONFIGURED.
 * Will flip to 'ready' (with requiresHumanSubmit semantics) once a sanctioned
 * directory API key and human-ops workflow are wired in.
 */
class DirectoryConnector implements ChannelConnector {
  readonly channelClass = "directory" as const;

  /**
   * Directory only supports publish (draft creation for human review).
   * No update or unpublish in the stub; human-submit workflow is Phase 3+.
   */
  readonly capabilities: ChannelCapability[] = ["publish"];

  /**
   * 'stub' — no directory API key available in v1-a phase.
   * Rows in content_deploy_queue for this channel stay 'queued' at dispatch.
   */
  readonly status = "stub" as const;

  /**
   * requiresHumanSubmit: true — this channel requires human sign-off for
   * submission even when keyed. Documented here for future implementors.
   */
  readonly requiresHumanSubmit = true as const;

  /**
   * NOT_CONFIGURED — this connector is a stub.
   *
   * The dispatch layer skips stub channels, so this path is normally unreachable.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Singleton Directory stub connector — status:'stub', publish→NOT_CONFIGURED. */
export const directoryConnector: ChannelConnector = new DirectoryConnector();
