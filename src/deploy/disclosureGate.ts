/**
 * src/deploy/disclosureGate.ts
 *
 * T10 — Disclosure gate (pure, no IO). §7#6 fail-closed disclosure check.
 *
 * §7#6 requires that any sponsored or affiliate content published to EXTERNAL
 * channels carries an explicit disclosure tag. The disclosure_tag field is
 * NULLABLE on content_asset (a null tag is valid for owned_net, which is our
 * own controlled property). However, for external distribution channels
 * (pr_wire, directory, web2, social), a null/empty tag is a compliance gap
 * that MUST block the publish.
 *
 * Two exports:
 *
 *   requiresDisclosure(channelClass)
 *     Pure boolean: true for external channels where a disclosure tag is
 *     required (pr_wire, directory, web2, social); false for owned_net and
 *     entity (entity has no 'publish' capability — its publish() always returns
 *     NOT_CONFIGURED, so disclosure is moot; we return false to avoid a
 *     spurious second gate block).
 *
 *   assertDisclosure(channelClass, disclosureTag)
 *     Returns { allowed: true } when the combination is compliant.
 *     Returns { allowed: false; reason: string } when a required disclosure
 *     tag is missing or empty — the caller BLOCKS the publish (fail-closed).
 *
 * Neither function performs IO; both are pure and synchronous.
 *
 * DESIGN-phase3.md §"Idempotency & Safety" / §"Disclosure (§7#6)".
 * SPEC §7#6, §8, §12.
 */

import type { ChannelClass } from "./connector.js";

// ---------------------------------------------------------------------------
// External channels that require a non-null disclosure tag
// ---------------------------------------------------------------------------

/**
 * The set of channel classes where a non-null, non-empty disclosure_tag is
 * REQUIRED before publish.
 *
 * owned_net  — OUR controlled property; disclosure is best-practice but not
 *              a hard gate (the tag IS rendered if present).
 * entity     — No 'publish' capability; always returns NOT_CONFIGURED.
 *              Disclosure gate is a no-op (moot), so entity is excluded.
 *
 * The four external publishing channels require disclosure because they
 * distribute content to third-party audiences where sponsored/affiliate
 * labelling is a legal and ToS requirement.
 */
const EXTERNAL_CHANNELS_REQUIRING_DISCLOSURE: ReadonlySet<ChannelClass> =
  new Set<ChannelClass>(["pr_wire", "directory", "web2", "social"]);

// ---------------------------------------------------------------------------
// requiresDisclosure
// ---------------------------------------------------------------------------

/**
 * requiresDisclosure — pure boolean predicate.
 *
 * Returns true when the channel class is in the external set that legally
 * requires a disclosure tag. Returns false for owned_net and entity.
 *
 * Used by publishUnit.ts to conditionally run assertDisclosure and by
 * disclosureGate tests to assert the per-channel policy.
 *
 * @param channelClass - The deploy channel being evaluated.
 * @returns            true if the channel requires disclosure; false otherwise.
 */
export function requiresDisclosure(channelClass: ChannelClass): boolean {
  return EXTERNAL_CHANNELS_REQUIRING_DISCLOSURE.has(channelClass);
}

// ---------------------------------------------------------------------------
// DisclosureCheckResult — typed return from assertDisclosure
// ---------------------------------------------------------------------------

export type DisclosureCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// ---------------------------------------------------------------------------
// assertDisclosure
// ---------------------------------------------------------------------------

/**
 * assertDisclosure — fail-closed §7#6 disclosure gate, pure and synchronous.
 *
 * Logic:
 *   - If requiresDisclosure(channelClass) is false → { allowed: true }
 *     (owned_net and entity are not blocked; entity is moot anyway).
 *   - If disclosureTag is null or empty string → { allowed: false, reason: ... }
 *     (fail-closed block: do NOT publish to external channels without a tag).
 *   - Otherwise → { allowed: true }
 *     (non-empty tag present, compliant).
 *
 * The caller (publishUnit.ts) checks the result BEFORE the claim-before-publish
 * step and BEFORE calling connector.publish(). A false result causes the publish
 * unit to mark the queue row as 'failed' and enqueue to the DLQ — the missing
 * disclosure_tag must be fixed before a retry can succeed.
 *
 * §7#6: disclosure_tag is rendered into the live artifact by OwnedNetConnector
 * and persisted to url_registry.disclosure_tag for audit trail regardless of
 * whether this gate ran (owned_net renders it if present, even though it is not
 * required). This gate only BLOCKS a null tag for external channels.
 *
 * @param channelClass  - The deploy channel being evaluated.
 * @param disclosureTag - The disclosure_tag from content_asset (nullable).
 * @returns             DisclosureCheckResult — allowed or blocked with reason.
 */
export function assertDisclosure(
  channelClass: ChannelClass,
  disclosureTag: string | null
): DisclosureCheckResult {
  if (!requiresDisclosure(channelClass)) {
    // owned_net and entity: disclosure is not a hard gate.
    return { allowed: true };
  }

  if (disclosureTag == null || disclosureTag.trim() === "") {
    return {
      allowed: false,
      reason:
        `Channel '${channelClass}' requires a non-empty disclosure_tag (§7#6) ` +
        `but content_asset.disclosure_tag is ${disclosureTag === null ? "null" : "empty"}. ` +
        `Set a disclosure tag before approving this asset for external publish.`,
    };
  }

  return { allowed: true };
}
