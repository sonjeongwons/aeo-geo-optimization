/**
 * src/deploy/connectors/web2.ts
 *
 * T08 — Web2 channel connector STUB.
 *
 * Automation grade: §8 P2 (API/RPA) — targets publishing platforms such as
 * Medium, dev.to, Hashnode, Brunch via their publish APIs.
 *
 * TODAY: status:'stub' — no Web2 platform API key exists. publish() returns
 * NOT_CONFIGURED. The connector flips to 'ready' when a sanctioned key is
 * added and publish() is implemented; the ChannelConnector interface does NOT
 * change.
 *
 * Key characteristics (documented, not enforced until keyed):
 *   - reversible: true — Web2 platforms generally provide a delete/retract API.
 *     unpublish() will be implemented alongside publish() when keyed.
 *   - capabilities: ['publish', 'update'] — Web2 supports overwriting/editing
 *     existing posts via API (e.g. PUT /articles/:id on dev.to).
 *   - No requiresHumanSubmit — fully automated when keyed (§8 P2 API grade).
 *
 * §0: publishedUrl must NEVER be the customer domain.
 * §7#3: no community/review connector — structural exclusion.
 * §7#6: disclosure_tag required (external channel).
 * §8: web2 is P2 (API-automated, no human submit required).
 * §12: no key, no scraping; stub until sanctioned key.
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
// Web2Connector
// ---------------------------------------------------------------------------

/**
 * Web2 stub connector (Medium / dev.to / Hashnode / Brunch).
 *
 * status:'stub' — publish() always returns NOT_CONFIGURED.
 * Will flip to 'ready' once a sanctioned Web2 platform API key is wired in.
 */
class Web2Connector implements ChannelConnector {
  readonly channelClass = "web2" as const;

  /**
   * Web2 supports publish and update (overwrite/edit via platform API).
   * unpublish will be added as a capability when keyed (reversible:true).
   */
  readonly capabilities: ChannelCapability[] = ["publish", "update"];

  /**
   * 'stub' — no Web2 API key available in v1-a phase.
   * Rows in content_deploy_queue for this channel stay 'queued' at dispatch.
   */
  readonly status = "stub" as const;

  /**
   * NOT_CONFIGURED — this connector is a stub.
   *
   * The dispatch layer skips stub channels, so this path is normally unreachable.
   * reversible:true when eventually implemented (Web2 platforms support delete).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Singleton Web2 stub connector — status:'stub', publish→NOT_CONFIGURED. */
export const web2Connector: ChannelConnector = new Web2Connector();
