/**
 * src/deploy/index.ts
 *
 * Barrel for the Phase 3 deploy connector layer.
 *
 * Re-exports the public surface of the deploy module. Individual sub-modules
 * are imported directly by consumers (e.g. src/deploy/connector.ts) to keep
 * tree-shaking effective. This barrel provides a single import point for
 * orchestration layers that need the full surface.
 *
 * Sub-modules (populated by T04–T16):
 *   connector.ts       — ChannelConnector interface + PublishResult union
 *   registry.ts        — ChannelRegistry + readiness()
 *   connectors/        — OwnedNetConnector (real) + stub connectors
 *   throttle.ts        — §7#5 naturalness throttle decision
 *   eligibility.ts     — isPublishEligible() pure predicate
 *   disclosureGate.ts  — §7#6 disclosure fail-closed gate
 *   publishUnit.ts     — publish.unit handler core
 *   dispatch.ts        — publish.dispatch handler
 *   verifyIndexing.ts  — publish.verify handler
 *   types.ts           — zod payload schemas + url_registry row types
 */

// This barrel is intentionally sparse in T01. Sub-module exports are added
// as each subsequent task (T04–T16) lands. Importing from the barrel before
// a sub-module exists will produce a compile error, which is the correct
// fail-closed behaviour.

export {};
