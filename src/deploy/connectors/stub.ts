/**
 * src/deploy/connectors/stub.ts
 *
 * T06 — Generic StubConnector factory for un-implemented / un-keyed channels.
 *
 * Mirrors src/providers/stub.ts:
 *   - status: 'stub' (channel known but not yet implemented or keyed)
 *   - publish() returns { ok:false, code:NOT_CONFIGURED } — never throws
 *   - unpublish() returns { ok:false, code:NOT_CONFIGURED }
 *
 * Used by:
 *   1. makeStubConnector(channelClass) — for each external channel file (T08)
 *      and as the deny-default StubConnector in the ChannelRegistry.get() path.
 *   2. The ChannelRegistry.get() path for any UNKNOWN channelClass — structural
 *      §7#3 exclusion: unknown channels (incl. 'community'/'review') get a DENY
 *      StubConnector so they can NEVER reach a real connector.
 *
 * SPEC §0, §7#3.
 * DESIGN-phase3.md §"Connector Abstraction", §"External Channels (stubs)".
 */

import { NOT_CONFIGURED } from "../connector.js";
import type {
  ChannelClass,
  ChannelCapability,
  ChannelConnector,
  PublishRequest,
  PublishResult,
} from "../connector.js";

// ---------------------------------------------------------------------------
// StubConnector — deny-default implementation
// ---------------------------------------------------------------------------

/**
 * StubConnector — a ChannelConnector that always returns NOT_CONFIGURED.
 *
 * Used:
 *   - For every external channel (pr_wire/directory/web2/social/entity) in v1-a
 *     until their API keys and implementations land.
 *   - As the DENY-DEFAULT returned by ChannelRegistry.get() for any channel
 *     class not registered (incl. 'community'/'review' — structural §7#3 guard).
 *
 * status:'stub' (not 'not_configured') — channel is KNOWN but unimplemented.
 * 'not_configured' is reserved for channels whose implementation is present
 * but whose API key is absent at runtime.
 */
export class StubConnector implements ChannelConnector {
  readonly channelClass: ChannelClass;
  readonly capabilities: ChannelCapability[];
  readonly status = "stub" as const;

  constructor(channelClass: ChannelClass, capabilities: ChannelCapability[] = []) {
    this.channelClass = channelClass;
    this.capabilities = capabilities;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async unpublish(_externalRef: string): Promise<PublishResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * makeStubConnector — create a StubConnector for a named channel class.
 *
 * The dispatcher skips work-units whose connector returns NOT_CONFIGURED,
 * so stubs produce zero side-effects without any special-casing upstream.
 *
 * @param channelClass  - The channel this stub represents.
 * @param capabilities  - Optional declared capabilities (informational; all
 *                        calls still return NOT_CONFIGURED).
 */
export function makeStubConnector(
  channelClass: ChannelClass,
  capabilities: ChannelCapability[] = []
): StubConnector {
  return new StubConnector(channelClass, capabilities);
}
