/**
 * src/deploy/connectors/social.ts
 *
 * T08 — Social channel connector STUB.
 *
 * Automation grade: §8 P3 (API) — targets social platforms such as LinkedIn
 * and X (formerly Twitter) via their publish APIs.
 *
 * TODAY: status:'stub' — no social platform API key exists. publish() returns
 * NOT_CONFIGURED. The connector flips to 'ready' when a sanctioned key is
 * added and publish() is implemented; the ChannelConnector interface does NOT
 * change.
 *
 * Key characteristics (documented, not enforced until keyed):
 *   - reversible: false — social post deletion is platform-specific and not
 *     guaranteed; do NOT promise reversibility.
 *   - capabilities: ['publish'] — no update (social posts are generally not
 *     editable via API without creating a new post); no unpublish.
 *   - No requiresHumanSubmit — fully automated when keyed (§8 P3 API grade).
 *
 * §0: publishedUrl must NEVER be the customer domain.
 * §7#3: no community/review connector — structural exclusion.
 * §7#6: disclosure_tag required (external channel).
 * §8: social is P3 (lowest priority automated channel, API-gated).
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
// SocialConnector
// ---------------------------------------------------------------------------

/**
 * Social stub connector (LinkedIn / X).
 *
 * status:'stub' — publish() always returns NOT_CONFIGURED.
 * Will flip to 'ready' once a sanctioned social platform API key is wired in.
 */
class SocialConnector implements ChannelConnector {
  readonly channelClass = "social" as const;

  /**
   * Social supports only publish; no update (posts are immutable on most
   * platforms) and no guaranteed unpublish (reversible:false).
   */
  readonly capabilities: ChannelCapability[] = ["publish"];

  /**
   * 'stub' — no social API key available in v1-a phase.
   * Rows in content_deploy_queue for this channel stay 'queued' at dispatch.
   */
  readonly status = "stub" as const;

  /**
   * NOT_CONFIGURED — this connector is a stub.
   *
   * The dispatch layer skips stub channels, so this path is normally unreachable.
   * reversible:false when eventually implemented.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Singleton Social stub connector — status:'stub', publish→NOT_CONFIGURED. */
export const socialConnector: ChannelConnector = new SocialConnector();
