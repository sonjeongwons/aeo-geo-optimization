/**
 * src/deploy/registry.ts
 *
 * T06 — ChannelRegistry with deny-default StubConnector + readiness reporting.
 *
 * Structural mirror of src/providers/registry.ts:
 *   - register(connector): add a connector to the registry.
 *   - get(channelClass): return the registered connector OR a DENY StubConnector
 *     for any unknown / unregistered channel (structural §7#3 guard — 'community'
 *     and 'review' channels can NEVER reach a real connector).
 *   - readiness(): per-channel status summary for the dispatcher.
 *
 * buildConnectorRegistry(connectors) — wire the registry from an array of
 * ChannelConnector instances. The caller is responsible for supplying the
 * real OwnedNetConnector (T07) and external stubs (T08). This keeps the
 * registry module free of concrete connector imports and fully testable
 * without side effects.
 *
 * SPEC §0, §7#3, §8.
 * DESIGN-phase3.md §"Connector Abstraction", §"External Channels (stubs)".
 */

import { makeStubConnector } from "./connectors/stub.js";
import { CHANNEL_CLASSES } from "./connector.js";
import type { ChannelClass, ChannelConnector, ChannelReadiness } from "./connector.js";

// ---------------------------------------------------------------------------
// ChannelRegistry interface
// ---------------------------------------------------------------------------

/**
 * ChannelRegistry — the one place connectors are looked up by channel class.
 *
 * get(channelClass) ALWAYS returns a ChannelConnector (never undefined). For
 * any channel class not registered — including 'community' and 'review' which
 * are structurally excluded from ChannelClass — it returns a DENY StubConnector
 * whose publish() returns NOT_CONFIGURED. This means an unknown channel CANNOT
 * publish without registering a real connector.
 *
 * readiness() reports the union of all REGISTERED connectors so the dispatcher
 * can skip non-'ready' channels at dispatch time (leaving their queue rows
 * 'queued', recoverable when keys arrive).
 */
export interface ChannelRegistry {
  /**
   * Register a connector. Last write wins per channelClass.
   * Only ChannelClass values are accepted as keys; TypeScript enforces this.
   */
  register(connector: ChannelConnector): void;

  /**
   * Get the connector for channelClass.
   * Returns the registered connector if present, or a DENY StubConnector
   * (status:'stub', publish→NOT_CONFIGURED) for any unknown channel class.
   *
   * STRUCTURAL §7#3: 'community'/'review' are not in ChannelClass, so they
   * can only arrive here as an escaped string. The deny-default ensures they
   * still cannot publish.
   */
  get(channelClass: string): ChannelConnector;

  /**
   * Per-channel readiness report for all REGISTERED connectors.
   *
   * The dispatcher uses this to skip non-'ready' channels (status:'stub' or
   * 'not_configured') at dispatch time so their rows stay 'queued' and remain
   * recoverable when API keys arrive.
   *
   * Only registered channels appear. Channels not yet wired by buildConnectorRegistry
   * do not appear (they would show as deny stubs via get() but have no readiness entry).
   */
  readiness(): ChannelReadiness[];
}

// ---------------------------------------------------------------------------
// createChannelRegistry — returns a ChannelRegistry instance
// ---------------------------------------------------------------------------

/**
 * Create and return a mutable ChannelRegistry.
 *
 * Connectors are registered via register(). The registry is closed over a Map;
 * it is NOT a singleton — callers should build once and share.
 */
export function createChannelRegistry(): ChannelRegistry {
  const connectors = new Map<ChannelClass, ChannelConnector>();

  return {
    register(connector: ChannelConnector): void {
      connectors.set(connector.channelClass, connector);
    },

    get(channelClass: string): ChannelConnector {
      // Check if channelClass is a registered ChannelClass value.
      // The deny-default is a StubConnector for any unknown channel
      // (including 'community'/'review' which are not in ChannelClass).
      const connector = connectors.get(channelClass as ChannelClass);
      if (connector !== undefined) {
        return connector;
      }
      // DENY-DEFAULT: unknown channels get a deny StubConnector.
      // We must pick a ChannelClass value for the stub — use 'owned_net' as
      // a sentinel placeholder ONLY for the deny stub; the channelClass field
      // in the returned connector is not used to route (the caller already
      // has the channel class they looked up). However, to be maximally correct
      // we cast the string and accept it as-is; the deny stub never publishes.
      //
      // Note: if channelClass is not in CHANNEL_CLASSES (e.g. 'community'),
      // we still return a deny stub — it just won't be in any registry entry.
      const safeClass = CHANNEL_CLASSES.includes(channelClass as ChannelClass)
        ? (channelClass as ChannelClass)
        : "owned_net"; // fallback sentinel; the stub returns NOT_CONFIGURED regardless
      return makeStubConnector(safeClass, []);
    },

    readiness(): ChannelReadiness[] {
      return [...connectors.values()].map((c) => ({
        channelClass: c.channelClass,
        status: c.status,
        capabilities: [...c.capabilities],
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// buildConnectorRegistry — inject connectors and return a ready registry
// ---------------------------------------------------------------------------

/**
 * buildConnectorRegistry — build a ChannelRegistry from an array of connectors.
 *
 * This is the factory used by the worker (T15) and CLIs (T16) to wire the
 * registry from the environment. The caller is responsible for constructing
 * the connector instances:
 *   - OwnedNetConnector (status:'ready', T07) for owned_net
 *   - StubConnectors (status:'stub', T08) for pr_wire/directory/web2/social/entity
 *
 * Keeping this module free of concrete connector imports allows:
 *   - The registry to be unit-tested without any side effects.
 *   - T07/T08 connectors to be developed independently (parallel group 3).
 *   - Future connectors to be injected with zero changes to registry.ts.
 *
 * The registry key set is guaranteed to be a SUBSET of ChannelClass
 * (enforced by ChannelConnector.channelClass type constraint + CHANNEL_CLASSES).
 *
 * @param connectors  Array of ChannelConnector instances to register. May be
 *                    empty (all channels fall back to deny stubs via get()).
 */
export function buildConnectorRegistry(
  connectors: readonly ChannelConnector[]
): ChannelRegistry {
  const registry = createChannelRegistry();
  for (const connector of connectors) {
    registry.register(connector);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// getChannelReadiness — convenience wrapper for CLI/status reporting
// ---------------------------------------------------------------------------

/**
 * getChannelReadiness — return the readiness report for a registry.
 *
 * Convenience wrapper used by deployStatus CLI (T16) and the dispatch
 * handler (T13) to filter for 'ready' channels before fan-out.
 *
 * @param registry  A ChannelRegistry built by buildConnectorRegistry.
 */
export function getChannelReadiness(registry: ChannelRegistry): ChannelReadiness[] {
  return registry.readiness();
}
