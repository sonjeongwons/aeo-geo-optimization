/**
 * src/deploy/connectors/entity.ts
 *
 * T08 — Entity channel connector STUB.
 *
 * Automation grade: §8 P2 (반수동·1회 / semi-manual, one-time) — targets
 * knowledge-base entity platforms such as Wikidata and Crunchbase.
 * These platforms are ALWAYS requiresHumanSubmit and NEVER auto-published.
 *
 * TODAY: status:'stub' — no entity platform key exists AND entity is
 * structurally ALWAYS NOT_CONFIGURED (publish() ALWAYS returns NOT_CONFIGURED
 * per the design decision: entity capabilities = [] and requiresHumanSubmit).
 * The connector NEVER flips to auto-publish; it may eventually return a
 * NEEDS_HUMAN_SUBMIT draft handle when keyed, but never a PublishOk.
 *
 * Key characteristics (ALWAYS enforced, not just when stubbed):
 *   - capabilities: [] — entity has NO 'publish' capability. The dispatcher
 *     will never enqueue a publish.unit for this channel. An entity asset
 *     cannot be auto-published.
 *   - requiresHumanSubmit: true — Wikidata/Crunchbase submissions require a
 *     human editor. Publishing is always manual and one-time (§8/§11).
 *   - reversible: false — entity records, once created, are not retractable
 *     via API.
 *   - This channel's queue rows stay 'queued' permanently in Phase 3
 *     (awaiting connector + human ops). No human-task table is built yet.
 *
 * §0: publishedUrl must NEVER be the customer domain.
 * §7#3: no community/review connector — structural exclusion.
 * §7#6: disclosure_tag carried but entity is out-of-scope for automated
 *        external-channel disclosure enforcement (always human).
 * §8: entity is P2 (반수동, one-time, requiresHumanSubmit).
 * §11: 고객 승인 / human ops — Wikidata/Crunchbase never auto-fire.
 * §12: ToS respected — no auto-submit ever (gray-zone automated edits banned).
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
// EntityConnector
// ---------------------------------------------------------------------------

/**
 * Entity stub connector (Wikidata / Crunchbase).
 *
 * status:'stub' — publish() ALWAYS returns NOT_CONFIGURED regardless of keys.
 * capabilities: [] — no 'publish' capability; cannot auto-publish.
 * requiresHumanSubmit: true — always requires human editor action.
 */
class EntityConnector implements ChannelConnector {
  readonly channelClass = "entity" as const;

  /**
   * Entity has NO publish capability.
   *
   * This is the STRUCTURAL guarantee that entity cannot be auto-published:
   * the dispatcher checks capabilities before enqueueing, and the absence of
   * 'publish' here means no publish.unit job will ever be created for entity.
   */
  readonly capabilities: ChannelCapability[] = [];

  /**
   * 'stub' — no entity API key available; entity is always requiresHumanSubmit
   * regardless of key presence.
   * Rows in content_deploy_queue for this channel stay 'queued' at dispatch.
   */
  readonly status = "stub" as const;

  /**
   * requiresHumanSubmit: true — entity submissions (Wikidata / Crunchbase)
   * require a human editor and are one-time. This is NEVER automated.
   */
  readonly requiresHumanSubmit = true as const;

  /**
   * NOT_CONFIGURED — entity ALWAYS returns this.
   *
   * Even if capabilities were extended in the future, publish() returns
   * NOT_CONFIGURED until a human-task workflow is explicitly built.
   * The dispatch layer skips stub channels (and skips channels with no
   * 'publish' capability), so this path is normally unreachable.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Singleton Entity stub connector — capabilities:[], publish→NOT_CONFIGURED.
 * NEVER auto-publishes (requiresHumanSubmit, one-time human editorial action).
 */
export const entityConnector: ChannelConnector = new EntityConnector();
