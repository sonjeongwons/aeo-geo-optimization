/**
 * src/deploy/connector.ts
 *
 * T04 — ChannelConnector interface + PublishResult discriminated union + ChannelClass.
 *
 * ONE structural seam for all deploy channels, mirroring src/providers/types.ts
 * ProviderAdapter pattern:
 *   - NOT_CONFIGURED is a typed RETURNED VALUE (re-exported from providers/types.ts),
 *     never thrown.
 *   - ChannelClass = the EXISTING content_asset channel_class enum (6 values).
 *     'community' and 'review' are INTENTIONALLY OMITTED — §7#3 structural exclusion.
 *   - PublishResult is a discriminated union; connectors never throw for missing keys.
 *   - ChannelConnector is the ONE seam; OwnedNetConnector is status:'ready' today;
 *     all external connectors are status:'stub'.
 *
 * Pure types, no IO.
 *
 * SPEC §0, §7#3, §7#5, §7#6, §8, §9, §11, §12.
 * DESIGN-phase3.md §"Connector Abstraction".
 */

// Re-export NOT_CONFIGURED as the same typed value from providers.
// Connectors return this (never throw) when unconfigured — identical to
// the ProviderAdapter pattern so orchestration layers can share the sentinel.
export { NOT_CONFIGURED } from "../providers/types.js";
export type { NotConfigured } from "../providers/types.js";

import type { NotConfigured } from "../providers/types.js";
import type { ContentBody, JsonLd } from "../content/types.js";

// Re-export for consumers of this module.
export type { ContentBody, JsonLd };

// ---------------------------------------------------------------------------
// ChannelClass — the EXISTING content_asset channel_class enum (§8)
// ---------------------------------------------------------------------------

/**
 * Legal channel classes for offsite content deployment.
 *
 * Values EXACTLY match the content_asset channel_class CHECK constraint
 * (migration 0009 / 0010).
 *
 * 'community' and 'review' are INTENTIONALLY OMITTED — §7#3 structural
 * exclusion: community/review is manual-only, never auto-deployed; no
 * connector file, no enum member. A registry-⊆-DB-CHECK test asserts this.
 */
export type ChannelClass =
  | "owned_net"
  | "pr_wire"
  | "directory"
  | "web2"
  | "social"
  | "entity";

/**
 * All legal ChannelClass values as a runtime array.
 * Used for registry validation and §7#3 subset assertions.
 */
export const CHANNEL_CLASSES: readonly ChannelClass[] = [
  "owned_net",
  "pr_wire",
  "directory",
  "web2",
  "social",
  "entity",
] as const;

// ---------------------------------------------------------------------------
// ChannelCapability
// ---------------------------------------------------------------------------

/**
 * Operations a connector may support.
 *
 * - 'publish':           write a new asset to the channel.
 * - 'update':            overwrite / patch an existing published asset.
 * - 'unpublish':         delete or retract the asset.
 * - 'confirm_indexing':  query whether the channel URL has been indexed.
 *
 * Connectors declare which they support via the `capabilities` array.
 * entity connector has capabilities [] (cannot publish — requiresHumanSubmit).
 */
export type ChannelCapability =
  | "publish"
  | "update"
  | "unpublish"
  | "confirm_indexing";

// ---------------------------------------------------------------------------
// PublishRequest
// ---------------------------------------------------------------------------

/**
 * Request passed to ChannelConnector.publish().
 *
 * Carries all fields needed for:
 *   - §0 off-site guard (the body may carry a DeferredUrl token resolved here)
 *   - §7#5 throttle (channelClass, customerId)
 *   - §7#6 disclosure (disclosureTag carried into the artifact + url_registry)
 *   - §12 audit (idempotencyKey, dryRun, language)
 *
 * idempotencyKey = assetId (one asset → one channel per existing schema);
 * the url_registry partial-unique (asset_id, channel_class) is the true arbiter.
 *
 * dryRun defaults to true; DEPLOY_DRY_RUN must be explicitly false (or CLI
 * --execute) for real writes.
 */
export interface PublishRequest {
  /** UUID of the content_asset being published. */
  assetId: string;

  /** Target channel for this publish operation. */
  channelClass: ChannelClass;

  /**
   * Customer UUID; null for generic owned-net assets.
   * JOINed from content_asset at dispatch time — the queue row has no customer_id.
   */
  customerId: string | null;

  /** BCP-47 language code matching the source asset. */
  language: string;

  /**
   * Parsed, typed content body (from content_asset.body).
   * Reused from src/content/types.ts — connectors render this to channel format.
   */
  body: ContentBody;

  /**
   * Optional JSON-LD structured data object (from content_asset body when
   * content_type='jsonld', or separately built).
   * OwnedNetConnector stamps datePublished before writing.
   */
  jsonLd?: JsonLd;

  /**
   * Sponsorship/affiliation disclosure tag (§7#6).
   * NULLABLE on content_asset — carried through here.
   * A fail-closed code gate blocks external channels (pr_wire/directory/web2/social)
   * when this is null (disclosureGate.ts); owned_net may be null.
   * Rendered into the live artifact and persisted to url_registry.disclosure_tag.
   */
  disclosureTag: string | null;

  /**
   * When true (the default) the connector MUST NOT perform any real write/API call.
   * It computes and returns a PublishDryRun result with plannedUrl.
   * Dry-run results are excluded from both the idempotency arbiter and the
   * throttle counter — previews never consume budget.
   */
  dryRun: boolean;

  /**
   * Stable idempotency key for this publish unit.
   * = assetId (one asset maps to one channel per content_asset.channel_class).
   * The url_registry partial-unique on (asset_id, channel_class) is the
   * authoritative claim arbiter; this key is carried for logging / singletonKey.
   */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// PublishResult discriminated union
// ---------------------------------------------------------------------------

/**
 * Successful publish: the asset is live at publishedUrl (OUR hub or external —
 * NEVER the customer domain).
 *
 * reversible: true when the channel supports unpublish() (owned_net, web2);
 * false when it does not (pr_wire, entity — no false promise).
 *
 * usage.usd is plumbed for future paid PR-wire APIs; not for LLM cost
 * (publishOk is pure-render, no Gemini calls in the happy path).
 */
export interface PublishOk {
  ok: true;
  /** The live URL on OUR hub or the external channel. NEVER the customer domain. */
  publishedUrl: string;
  /** Channel-internal reference for update/unpublish operations (e.g. post ID). */
  externalRef?: string;
  /** True when unpublish() can retract this publish (owned_net file delete = true). */
  reversible: boolean;
  /** Optional cost (e.g. future paid PR-wire API). */
  usage?: { usd: number };
  /** Channel-specific metadata persisted to url_registry.publish_meta. */
  meta: Record<string, unknown>;
}

/**
 * Dry-run result: no real write occurred; plannedUrl is the URL that WOULD have
 * been published.
 *
 * publish_status='dry_run' in url_registry — excluded from the idempotency
 * arbiter (so a later real publish can proceed) and from the throttle counter
 * (so previews never consume cadence budget).
 */
export interface PublishDryRun {
  ok: true;
  dryRun: true;
  /** The URL that would have been published if dryRun were false. */
  plannedUrl: string;
}

/**
 * Connector is not configured (key absent, channel stubbed).
 * Uses the same NOT_CONFIGURED sentinel as GenerateNotConfigured so
 * orchestration layers can share dispatch logic.
 */
export interface PublishNotConfigured {
  ok: false;
  code: NotConfigured;
}

/**
 * Throttled by the §7#5 naturalness throttle.
 * The dispatcher defers the job (re-queue with delay), never drops it.
 */
export interface PublishThrottled {
  ok: false;
  code: "THROTTLED";
  retryAfterMs: number;
}

/**
 * Channel-level publish error.
 *
 * retryable: true → RetryableJobError; false → PermanentJobError / DLQ.
 */
export interface PublishError {
  ok: false;
  /** Error code, e.g. 'RATE_LIMITED' | 'TIMEOUT' | 'CHANNEL_ERROR' | 'BLOCKED'. */
  code: string;
  message: string;
  /** Whether the pipeline may retry this job. */
  retryable: boolean;
}

/**
 * PublishResult — discriminated union returned by ChannelConnector.publish().
 *
 * Discriminant paths:
 *   ok:true  + dryRun:true  → PublishDryRun
 *   ok:true  (no dryRun)    → PublishOk
 *   ok:false + NOT_CONFIGURED → PublishNotConfigured (stub channel, skip)
 *   ok:false + 'THROTTLED'  → PublishThrottled (defer + re-queue)
 *   ok:false + other code   → PublishError (retryable or permanent)
 */
export type PublishResult =
  | PublishOk
  | PublishDryRun
  | PublishNotConfigured
  | PublishThrottled
  | PublishError;

// ---------------------------------------------------------------------------
// ChannelConnector interface
// ---------------------------------------------------------------------------

/**
 * ChannelConnector — the ONE seam all deploy channels implement.
 *
 * Structural mirror of ProviderAdapter from src/providers/types.ts:
 *   - status:'ready' → only OwnedNetConnector today (no external API keys).
 *   - status:'stub'  → all external connectors (pr_wire/directory/web2/social/entity).
 *   - status:'not_configured' → reserved for runtime key-absent detection.
 *   - publish() is always present; unpublish()/confirmIndexing() are optional
 *     capabilities (declared in `capabilities` array).
 *   - Connectors NEVER throw for missing keys; they return NOT_CONFIGURED.
 *
 * §0: publishedUrl must NEVER be the customer domain.
 * §7#3: no community/review connector exists (structural exclusion).
 * §7#5: throttle is enforced BEFORE publish() by the dispatch layer.
 * §7#6: disclosure_tag is carried in PublishRequest and rendered into the artifact.
 */
export interface ChannelConnector {
  /**
   * Channel this connector serves.
   * Exactly one of the 6 ChannelClass values — no community/review.
   */
  readonly channelClass: ChannelClass;

  /**
   * Operations this connector supports.
   * Used by the dispatcher to route optional operations.
   * entity connector has [] (cannot auto-publish — requiresHumanSubmit).
   */
  readonly capabilities: ChannelCapability[];

  /**
   * Connector readiness:
   *   'ready'         → fully implemented + keyed; will perform real side effects.
   *   'stub'          → not yet implemented or keyed; publish() returns NOT_CONFIGURED.
   *   'not_configured'→ implementation present but key absent at runtime.
   */
  readonly status: "ready" | "stub" | "not_configured";

  /**
   * Publish the asset to the channel.
   *
   * MUST respect req.dryRun (default true):
   *   dryRun:true  → compute plannedUrl, write NOTHING, return PublishDryRun.
   *   dryRun:false → perform the real write, return PublishOk on success.
   *
   * Stubbed connectors return { ok:false, code:NOT_CONFIGURED } regardless of
   * dryRun — they are skipped at dispatch so this path is normally unreachable.
   *
   * §0 STRUCTURAL: the returned publishedUrl must NEVER be the customer domain.
   * OwnedNetConnector resolves the deferred token against config; a blocklist
   * guard rejects any matching host.
   */
  publish(req: PublishRequest): Promise<PublishResult>;

  /**
   * Retract a previously published asset.
   * Only available when 'unpublish' ∈ capabilities.
   * Returns PublishOk (reversible:true on success) or PublishError.
   * Channels that cannot unpublish (pr_wire, entity) do NOT implement this.
   *
   * @param externalRef - Channel-internal reference from the original PublishOk.
   */
  unpublish?(externalRef: string): Promise<PublishResult>;

  /**
   * Query whether the published URL has been indexed by the target engine.
   * Only available when 'confirm_indexing' ∈ capabilities.
   *
   * NEVER returns indexed:true for owned_net FsTarget (local file is not
   * crawlable — §7#3 / no false signal into the monitor).
   * Real confirmation is Phase 4 SERP/Indexing API territory (§12).
   */
  confirmIndexing?(
    publishedUrl: string
  ): Promise<{ indexed: boolean; checkedAt: Date }>;
}

// ---------------------------------------------------------------------------
// ChannelReadiness — registry summary type
// ---------------------------------------------------------------------------

/**
 * Per-channel readiness summary returned by ChannelRegistry.readiness().
 * Used by the dispatcher to skip non-'ready' channels at dispatch time
 * (leaving rows 'queued', recoverable when keys arrive).
 */
export interface ChannelReadiness {
  channelClass: ChannelClass;
  status: "ready" | "stub" | "not_configured";
  capabilities: ChannelCapability[];
}
