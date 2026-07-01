# Phase 3 — Deploy Connector Layer + Publish Tracking — Canonical Design

> Source: `phase3-design` workflow (3 Opus proposals → adversarial cross-check → synthesis). Builds on verified Phase 0/1/2.
> Authoritative: `SPEC.md` §8 channels, §0 off-site, §7 (#3 no-fake-signals, #5 naturalness throttle, #6 disclosure), §9, §11, §12.
> FIRST phase with real outward side effects — every safety property is fail-closed + structural.

## Overview

Phase 3 is the off-site deploy connector layer + publish tracking, layered on verified Phase 0/1/2. It CONSUMES the Phase 2 content_deploy_queue (gate_status='passed' rows) and publishes assets OFF-SITE (SPEC §0) to OUR owned-net hub and external channels — NEVER the customer site. As the FIRST phase with real outward side effects, every safety property is fail-closed and structural.

Canonical resolution of the three proposals + adversarial reviews:
- ONE ChannelConnector seam mirroring providers/types.ts ProviderAdapter (NOT_CONFIGURED as a typed RETURNED value, status 'ready'|'stub'|'not_configured', a ChannelRegistry with readiness()). channel_class is the EXISTING content_asset enum (owned_net,pr_wire,directory,web2,social,entity) — community/review structurally absent (no connector file, no enum member, asserted by a registry-⊆-DB-CHECK test).
- ONLY OwnedNetConnector is REAL-TODAY: resolves the EXISTING Phase 2 deferred-url token ({deferred:true,role:'owned_hub'}) against config (never a free-form URL), derives slug from the ASSET ROW (industry/language/phrasing_group_id — the token carries none), stamps datePublished, writes a static tree via an OwnedNetTarget {writePage,writeSitemap,deletePage} seam (FsTarget real today, S3/CDN swap later, NO cloud creds). pr_wire/directory/web2/social/entity are typed NOT_CONFIGURED STUBS.
- IDEMPOTENCY: ONE authoritative arbiter — a partial UNIQUE on url_registry (asset_id, channel_class) WHERE publish_status IN ('publishing','published'). NO connector_version in any key. The ledger row is CLAIMED ('publishing' with ON CONFLICT DO NOTHING, branch on rows-affected) BEFORE the connector side effect, so a retried job against a non-idempotent external channel cannot double-publish. Unique violations are no-ops, not job failures.
- §7#5 NATURALNESS THROTTLE: fail-closed code gate BEFORE connector.publish(); cap check + claim + counter increment in the SAME transaction as the queue-row lease (channel_throttle_state row-locked), per-(customer_id, channel_class) with customer_id JOINed from content_asset. Over-cap defers (re-queue with delay), never drops; dry-run consumes no budget.
- ELIGIBILITY re-derived at execute time (gate_status='passed' re-read + human-approved + leased); approved_by/approved_at with approver identity for §12. queuePassedAssets keeps inserting status='queued' (approval NULL) so every row is fail-closed not-eligible until approveDeploy CLI signs it.
- PUBLISH TRACKING / §3 feedback is STRICTLY read-only: Phase 3 WRITES url_registry; Phase 0 reads via an additive query, consumer DEFERRED to Phase 4. NO auto-seeding of monitoring questions, NO cycle.plan edit. owned_net file-presence → indexing_status 'submitted'/'unknown' only, NEVER 'indexed'.
- Reuses pg-boss verbatim (3 queues + 2 DLQs), RetryableJobError/PermanentJobError, SKIP LOCKED lease. NOT_CONFIGURED stub channels SKIPPED at dispatch (rows stay 'queued', recoverable) — never enqueued, never DLQ-looped. ONE migration 0010 (PLAIN tables + ALTER), transactional .sql — no hypertable/CAGG/policy DDL.

## Connector Abstraction

src/deploy/connector.ts — the ONE seam, structural mirror of providers/types.ts ProviderAdapter:

- Re-export NOT_CONFIGURED (typed value, never thrown). ChannelClass = the EXISTING content_asset channel_class enum: 'owned_net'|'pr_wire'|'directory'|'web2'|'social'|'entity' (NO community/review).
- ChannelCapability = 'publish'|'update'|'unpublish'|'confirm_indexing'.
- PublishRequest { assetId; channelClass; customerId: string|null; language; body: ContentBody (reused from src/content/types.ts); jsonLd?: JsonLd; disclosureTag: string|null (carried from content_asset, §7#6); dryRun: boolean (default true); idempotencyKey: string (= assetId; one asset → one channel per existing schema) }.
- PublishResult discriminated union (mirrors GenerateResult): PublishOk { ok:true; publishedUrl (OUR hub or external — NEVER customer domain); externalRef?; reversible:boolean; usage?:{usd:number}; meta } | PublishDryRun { ok:true; dryRun:true; plannedUrl } | PublishNotConfigured { ok:false; code:NOT_CONFIGURED } | PublishThrottled { ok:false; code:'THROTTLED'; retryAfterMs } | PublishError { ok:false; code:string; message; retryable:boolean }.
- ChannelConnector { readonly channelClass; readonly capabilities; readonly status:'ready'|'stub'|'not_configured'; publish(req):Promise<PublishResult>; unpublish?(externalRef):Promise<PublishResult>; confirmIndexing?(publishedUrl):Promise<{indexed:boolean; checkedAt:Date}> }.

src/deploy/registry.ts — ChannelRegistry mirroring providers/registry.ts: register(connector); get(channelClass) → connector | a default DENY StubConnector (unknown channel CANNOT publish); readiness():ChannelReadiness[]. The dispatcher uses readiness() to SKIP non-'ready' channels (rows stay 'queued', shown as 'awaiting connector keys').

Structural §7#3 exclusion: no community/review connector file, no enum member; test asserts the registry key set is a SUBSET of the content_asset channel_class CHECK (single upstream source of truth — no drift-prone second enum).

## Owned-Net (real today)

src/deploy/connectors/ownedNet.ts — the ONLY status:'ready' connector today, capabilities ['publish','update','unpublish','confirm_indexing'], reversible:true. Needs NO channel API key and NO cloud creds.

OwnedNetTarget interface { writePage(path,bytes); writeSitemap(entries); deletePage(path); baseUrl():string } — the swap seam (mirrors providers/gemini.ts). Real-today impl = FsTarget writing to OWNED_NET_OUT_DIR (default ./.owned-net-out). S3Target/CdnTarget (IaC, cred-gated) slot in later with ZERO connector-interface change.

publish() steps:
1. §0 STRUCTURAL: the asset's JSON-LD carries the EXISTING Phase 2 deferred token {deferred:true,role:'owned_hub'}. The connector resolves it against OWNED_NET_HUB_BASE_URL (config) — it NEVER accepts a free-form URL string, so the customer domain stays structurally unrepresentable. Defense-in-depth: a fail-closed CUSTOMER_DOMAIN_BLOCKLIST guard rejects any resolved host on the blocklist, enforced INSIDE the connector AND again in publishUnit.
2. Derive slug deterministically from the ASSET ROW (industry/language/phrasing_group_id) — the token carries no slug/industry/language. publishedUrl = baseUrl()+/{lang}/{slug}/. Only role='owned_hub' is resolved for owned_net; social_profile/entity_page tokens belong to their (stubbed) channels.
3. Render the typed ContentBody + JSON-LD (datePublished stamped = now) into a deterministic static HTML page (pure templates per content_type: definition/answer_block/faq/comparison/case_study + <script type=application/ld+json>); render the disclosure_tag into the artifact (§7#6). Write <out>/{lang}/{slug}/index.html + a sitemap entry. Byte-identical on re-render (overwrite-safe).
4. Return PublishOk { publishedUrl, reversible:true, meta:{outPath,hubBaseUrl} }.

unpublish() deletes the file + sitemap entry. update() re-renders in place.

STUBBED within owned_net: real DNS/CDN/IaC provisioning — the local file is NOT publicly crawlable, so confirmIndexing returns indexed:false → indexing_status held at 'submitted'/'unknown' (NEVER 'indexed') until the S3/CDN target is wired. Documented as the cred-gated swap.

## External Channels (stubs)

All external connectors are typed STUBS today (only Gemini is keyed; NO channel keys exist), each a real file exporting a ChannelConnector with status:'stub' and publish() returning {ok:false, code:NOT_CONFIGURED} — mirroring providers/stub.ts. They flip to 'ready' by implementing publish() + reading a key from env when it arrives; interface and pipeline do NOT change.

- prWire.ts (§8 P1, auto) caps ['publish'], reversible:false. Will syndicate 1 release → many outlets; throttle treats the fan-out as ONE publish event. PR-wire syndication CHILD URLs are OUT OF SCOPE for the (asset_id, channel_class) idempotency arbiter — modeled later in a separate syndication-children table, NOT by relaxing the primary unique (do not bake the contradiction in).
- directory.ts (§8 P2, 반자동) caps ['publish'], requiresHumanSubmit:true. Even when keyed, publish() returns a NEEDS_HUMAN_SUBMIT draft handle — never a fully-auto submit (§11 휴먼옵스, respects ToS).
- web2.ts (§8 P2, API/RPA) caps ['publish','update'], reversible:true. Medium/dev.to/Hashnode/Brunch.
- social.ts (§8 P3, API) caps ['publish']. LinkedIn/X.
- entity.ts (§8 P2, 반수동·1회) caps [] (NO 'publish'), requiresHumanSubmit:true. ALWAYS returns NOT_CONFIGURED; Wikidata/Crunchbase never auto-published.

requiresHumanSubmit channels (directory/entity) are marked OUT-OF-SCOPE-until-a-future-phase for actual submission — NO human-task table is built in Phase 3; their queue rows simply stay 'queued' (awaiting connector + human ops). Explicit, not a silent drop.

STRUCTURAL §7#3 EXCLUSION: NO communityConnector/reviewConnector file, no community/review member in ChannelClass (content_asset CHECK already omits them at migration 0009). A community/review asset cannot be generated, queued, or routed. Tests assert the registry key set ⊆ the content_asset channel_class enum.

## Naturalness Throttle (§7#5)

§7#5 enforced as a fail-closed CODE GATE that runs BEFORE connector.publish() and is TRANSACTIONALLY bound to the claim (resolving the count-then-publish race all three proposals admitted).

src/deploy/throttle.ts:
- channel_throttle (migration 0010, PLAIN, config): { channel_class PK, max_per_day int, max_per_week int, min_interval_minutes int, enabled bool }. Seeded conservatively (owned_net generous = OUR hub; pr_wire/social tight). NULL/missing policy → fail-closed allow=false (uses DEPLOY_DEFAULT_MAX_PER_DAY only if explicitly enabled).
- channel_throttle_state (migration 0010, PLAIN, counter): { customer_id (NULL bucket via COALESCE for generic owned-net), channel_class, window_start, count, last_publish_at } — durable, row-locked.
- canPublishNow is enforced ATOMICALLY inside the dispatch claim transaction: SELECT ... FOR UPDATE on the throttle-state row, check max_per_day/max_per_week/min_interval, then claim the queue batch (SKIP LOCKED) up to remaining budget and increment the counter — all in ONE tx. The cap is a real guard, not a separate live COUNT. Counter read failure → allow=false (fail-closed).
- Per-(customer_id, channel_class): customer_id JOINed from content_asset (the queue has no customer_id; generic owned-net = NULL bucket) so one noisy customer cannot starve another, plus a global per-channel ceiling.
- Cadence: min_interval_minutes spaces publishes (no bursts). Over-cap → defer (re-queue with delay + jitter), NEVER drop.
- DRY-RUN: respects/logs the decision but writes NO counter increment and NO ledger row, so previews never consume cadence budget nor block a later real publish.

The §7#5 analogue of the Phase 0 budget gate — hard, fail-closed, transactional, wired for ALL channels so a future key cannot bypass it.

## Publish Tracking + §3 Feedback

url_registry (migration 0010, PLAIN — bounded catalog like content_asset, NOT a hypertable) is BOTH the idempotent publish ledger AND the §3/§9 publish-tracking surface the Phase 0 monitoring loop reads.

Columns: id uuid PK; asset_id uuid NOT NULL; content_set_id uuid NULL; customer_id uuid NULL (copied from content_asset at publish; NULL = generic owned-net); channel_class text NOT NULL; published_url text NOT NULL; external_ref text NULL; disclosure_tag text NULL (carried, §7#6 audit); language text NOT NULL; publish_status text CHECK IN ('publishing','published','dry_run','failed','unpublished'); indexing_status text CHECK IN ('unknown','submitted','indexed','not_indexed') DEFAULT 'unknown'; first_seen_indexed_at timestamptz NULL; approver_audit jsonb NULL; publish_meta jsonb; published_at timestamptz NULL; created_at timestamptz DEFAULT now().

- PARTIAL UNIQUE uq_url_registry_live ON (asset_id, channel_class) WHERE publish_status IN ('publishing','published') — the SINGLE idempotency arbiter (at-most-one live/claimed row per asset+channel; dry_run/failed/unpublished excluded so previews and retries coexist).
- INDEX on (indexing_status), (customer_id), (published_at).

INDEXING CONFIRMATION (ToS-safe, §12): publish.verify jobs (delayed + backoff) call connector.confirmIndexing? where supported, else 'unknown'. owned_net FsTarget local file is NOT crawlable, so file-presence sets indexing_status='submitted' at most — NEVER 'indexed' (no false 'live' signal into the monitor). NO raw scraping of Google AI Overviews/Naver (§12 — Phase 4 SERP API territory).

§3 FEEDBACK — STRICTLY READ-ONLY contract: Phase 3 ONLY writes url_registry. A NEW additive repo read fn listPublishedUrlsForMonitoring(customerId?, since?) returns registry rows for a future Phase 0/4 consumer. Phase 3 does NOT edit cycle.plan, does NOT write the measurement context, and does NOT auto-seed monitoring questions from published phrasings (that would fabricate §14 lift and bypass the §5.5 human question gate). The loop is closeable (table + read fn delivered); the consumer is DEFERRED to Phase 4.

## Idempotency & Safety

Layered, conservative — first phase with outward side effects.

ELIGIBILITY (gate-passed + queued + human-approved, re-checked at execute time): publishUnit re-derives eligibility, never trusts the leased row — (a) queue row leased, (b) live content_asset.gate_status='passed' re-read (fail-closed if a re-gate flipped it), (c) approved_by NOT NULL. isPublishEligible() is a pure exported predicate mirroring isQueueEligible.

HUMAN-APPROVAL: a NEW mandatory step. content_deploy_queue gains approved_by/approved_at; queuePassedAssets keeps inserting status='queued' with approval NULL, so every queued row is fail-closed NOT eligible until src/cli/approveDeploy.ts sets approver IDENTITY + timestamp (§11 고객 승인, §12 audit — not a bare boolean). Approver audit copied into url_registry.approver_audit.

IDEMPOTENCY — ONE arbiter, CLAIM-BEFORE-SIDE-EFFECT: arbiter = url_registry partial-unique on (asset_id, channel_class) WHERE publish_status IN ('publishing','published'). NO connector_version in the key. publishUnit FIRST inserts a publish_status='publishing' claim row with ON CONFLICT DO NOTHING; it proceeds to connector.publish() ONLY if THIS worker won the claim (rows-affected=1). On ok → UPDATE to 'published'. Prevents a redelivered job from double-hitting a non-idempotent irreversible channel (pr_wire/entity). A unique violation is caught and treated as a no-op, NOT a 'failed' DLQ.

DRY-RUN: dryRun defaults true; DEPLOY_DRY_RUN must be explicitly false (or CLI --execute) for real writes. Dry-run runs the full pipeline (eligibility + throttle + connector dry mode), logs plannedUrl, writes a publish_status='dry_run' row EXCLUDED from both the idempotency arbiter AND the throttle count — so it never strands the queue row or consumes budget.

§0 OFF-SITE: owned_net resolves the deferred token against config (free-form URL unrepresentable) + fail-closed CUSTOMER_DOMAIN_BLOCKLIST guard inside the connector AND in publishUnit. External connectors stubbed.

REVERSIBILITY: unpublish?() where the channel has a delete handle (owned_net file delete = true; pr_wire/entity declare reversible:false — no false promise). publish_status='unpublished' is terminal reversible.

DISCLOSURE (§7#6): disclosure_tag is NULLABLE on content_asset. A CODE GATE BLOCKS publish to external channels (pr_wire/directory/web2/social) when disclosure_tag IS NULL (fail-closed); owned_net may be null. The tag is rendered into the live artifact and persisted to url_registry for audit.

## Queue Consumption

Reuses pg-boss + content_deploy_queue verbatim; adds 3 queues + 2 DLQs to the EXISTING createQueue list in queue.ts and works them in worker.ts via the injected-handler pattern (same as cycle.*).

JOB_NAMES extension in jobs.ts: PUBLISH_DISPATCH='publish.dispatch', PUBLISH_UNIT='publish.unit', PUBLISH_VERIFY='publish.verify'; DLQ_PUBLISH_UNIT, DLQ_PUBLISH_VERIFY. Zod payload schemas mirror CyclePlan/ResponseRun.

LEASE / STATUS LIFECYCLE: migration 0010 ALTERs content_deploy_queue (PLAIN, additive legal) — DROP the status CHECK ('queued' only) and widen to ('queued','leased','published','failed','unpublished'). dry_run is NOT a queue status (it is a url_registry publish_status), and there is NO 'deferred' queue status (deferral = re-queue to 'queued' with delay) — so a preview or a deferral NEVER strands a row out of the claim predicate. Add leased_at timestamptz, attempts int DEFAULT 0, approved_by text, approved_at timestamptz. No test pins the old single-value CHECK (verified: queueForDeploy + its tests only insert status='queued'), so the ALTER is safe.

claimNextDeployBatch(channelClass, limit): atomic UPDATE ... SET status='leased', leased_at=now(), attempts=attempts+1 WHERE id IN (SELECT id FROM content_deploy_queue JOIN content_asset ON asset_id WHERE status='queued' AND approved_by IS NOT NULL AND <throttle budget remaining for content_asset.customer_id+channel> FOR UPDATE SKIP LOCKED LIMIT n) RETURNING * — throttle check + counter increment in the SAME transaction (§7#5). A stale-lease reaper resets status='queued' for leased rows older than DEPLOY_LEASE_TIMEOUT_MS.

FLOW:
1. publish.dispatch (durable cron OR manual) — reaps stale leases; for each 'ready' channel (registry.readiness — STUB channels SKIPPED, rows stay 'queued', never enqueued/DLQ'd), computes remaining throttle budget, claims a batch, enqueues one publish.unit per claimed row with singletonKey=`publish:${assetId}:${channelClass}`.
2. publish.unit — zod-validate; re-check eligibility + disclosure gate; CLAIM the url_registry 'publishing' row (ON CONFLICT DO NOTHING); if not the winner → no-op resolve. Else load body + JSON-LD, build PublishRequest, call connector.publish(). On ok → UPDATE registry to 'published', queue status='published', enqueue publish.verify (delayed). On throttled → queue back to 'queued' + RetryableJobError with delay. On NOT_CONFIGURED → normally unreachable (dispatch skips stubs); if hit, mark registry row 'failed', queue back to 'queued', resolve without retry (no loop). On retryable error → RetryableJobError. On non-retryable → queue 'failed' + DLQ.
3. publish.verify — confirmIndexing, stamp indexing_status; backoff to a cap then 'unknown'.

RETRIES/DLQ: reuse RetryableJobError/PermanentJobError + the existing throw-to-retry / catch-to-resolve pattern. NOT_CONFIGURED reconciled with the EXISTING DEAD_LETTER_ERROR_CODES: stub channels filtered at dispatch (never enqueued) so no infinite re-claim/re-fail loop.

## Cost & Compliance

§11 COST: publishing is near-zero LLM cost — owned_net rendering is pure/deterministic ($0); no Gemini calls in the happy path, so the Phase 0 GLOBAL_*_USD_CAP is irrelevant here (documented). Dominant cost is HUMAN-OPS, surfaced explicitly: 고객 승인 (approveDeploy CLI w/ approver identity), 디렉터리 제출 + entity (requiresHumanSubmit connectors never auto-fire), PR 진성 work. PublishOk.usage.usd is plumbed for future paid PR-wire APIs and recorded in url_registry.publish_meta (NOT insertLlmCall — that is LLM-shaped; keep deploy cost out of cost_daily). No new cost-cap machinery beyond the throttle, which doubles as the volume/spend governor.

§12 COMPLIANCE: ToS respected — every external connector is a STUB until a SANCTIONED key + human review exists (no scraping, no keyless RPA in this phase). Indexing confirmation uses only OUR-property checks + official indexing APIs when keyed; raw scraping of AI Overviews/Naver is gray-zone and is Phase 4 MONITORING, explicitly out of scope. §7#6 disclosure carried into the live artifact + persisted to url_registry for audit; fail-closed block when a required (sponsored/affiliate) channel has a null tag. §7#3 community/review structurally excluded. §0 customer-domain unrepresentable (deferred token) + fail-closed blocklist guard. §7#5 throttle = transactional code gate. requiresHumanSubmit honors §8 automation grades (반자동/반수동). Every publish writes an auditable url_registry row (disclosure_tag, channel, url, status, approver_audit, meta) for §12.

## New Migrations (0010+)

ONE migration: src/db/migrations/0010_phase3_deploy.sql — fully transactional .sql (all PLAIN tables + ALTER; NO hypertable/CAGG/policy DDL, so no .cjs needed; 0010 confirmed next free). All ops idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).

1. url_registry (PLAIN — bounded ledger, same reasoning as content_asset; kept PLAIN to avoid the hypertable partition-col unique-index rule):
   id uuid PK DEFAULT gen_random_uuid(); asset_id uuid NOT NULL; content_set_id uuid NULL; customer_id uuid NULL; channel_class text NOT NULL CHECK IN ('owned_net','pr_wire','directory','web2','social','entity') [single-table CHECK, mirrors content_asset, excludes community/review §7#3]; published_url text NOT NULL; external_ref text NULL; disclosure_tag text NULL; language text NOT NULL; publish_status text NOT NULL CHECK IN ('publishing','published','dry_run','failed','unpublished'); indexing_status text NOT NULL DEFAULT 'unknown' CHECK IN ('unknown','submitted','indexed','not_indexed'); first_seen_indexed_at timestamptz NULL; approver_audit jsonb NULL; publish_meta jsonb NULL; published_at timestamptz NULL; created_at timestamptz NOT NULL DEFAULT now().
   - CREATE UNIQUE INDEX uq_url_registry_live ON url_registry (asset_id, channel_class) WHERE publish_status IN ('publishing','published');  -- the SINGLE idempotency arbiter
   - CREATE INDEX ix_url_registry_indexing ON url_registry (indexing_status);
   - CREATE INDEX ix_url_registry_customer ON url_registry (customer_id);
   - CREATE INDEX ix_url_registry_published_at ON url_registry (published_at);

2. channel_throttle (PLAIN, config): channel_class text PRIMARY KEY CHECK IN (the 6 enum); max_per_day int NOT NULL; max_per_week int NOT NULL; min_interval_minutes int NOT NULL; enabled boolean NOT NULL DEFAULT true. Seed conservative rows (owned_net generous; pr_wire/social tight) via INSERT ... ON CONFLICT DO NOTHING.

3. channel_throttle_state (PLAIN, counter): id uuid PK DEFAULT gen_random_uuid(); customer_id uuid NULL; channel_class text NOT NULL; window_start timestamptz NOT NULL; count int NOT NULL DEFAULT 0; last_publish_at timestamptz NULL. CREATE UNIQUE INDEX uq_throttle_state ON channel_throttle_state (COALESCE(customer_id,'00000000-0000-0000-0000-000000000000'::uuid), channel_class) [NULL-customer bucket via COALESCE so the per-customer counter is unique incl. generic owned-net].

4. ALTER content_deploy_queue (PLAIN, additive + CHECK swap):
   - ALTER TABLE content_deploy_queue DROP CONSTRAINT IF EXISTS content_deploy_queue_status_check;
   - ALTER TABLE content_deploy_queue ADD CONSTRAINT content_deploy_queue_status_check CHECK (status IN ('queued','leased','published','failed','unpublished'));
   - ADD COLUMN IF NOT EXISTS leased_at timestamptz;
   - ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
   - ADD COLUMN IF NOT EXISTS approved_by text;
   - ADD COLUMN IF NOT EXISTS approved_at timestamptz;
   (uq_deploy_queue_asset on (asset_id) retained unchanged.)

No cross-table CHECK; every CHECK is single-table. No hypertable touched.

## Module Tree

NEW src/deploy/ (additive, mirrors src/providers/ + src/content/):
- connector.ts        — ChannelConnector interface, PublishRequest/PublishResult union, NOT_CONFIGURED re-export, ChannelCapability, ChannelClass.
- registry.ts         — ChannelRegistry (register/get/readiness) + default DENY StubConnector + getChannelReadiness().
- connectors/ownedNet.ts — REAL connector + OwnedNetTarget interface; FsTarget (real-today) with S3/CDN swap seam; deferred-url token resolver (role='owned_hub'); §0 host-blocklist guard.
- connectors/render.ts — PURE deterministic HTML + JSON-LD renderers per ContentBody type (reuses src/content/types.ts + JsonLd).
- connectors/stub.ts  — generic StubConnector factory (status:'stub', publish→NOT_CONFIGURED).
- connectors/prWire.ts | directory.ts | web2.ts | social.ts | entity.ts — STUB connectors (capabilities + automation-grade/requiresHumanSubmit notes).
- throttle.ts         — §7#5 canPublishNow pure decision + transactional channel_throttle/channel_throttle_state counter (fail-closed).
- eligibility.ts      — isPublishEligible() pure predicate (gate_status re-check + approved + leased).
- disclosureGate.ts   — fail-closed disclosure-required check per channel.
- publishUnit.ts      — publish.unit handler core (claim-before-publish, dry-run aware, idempotent).
- dispatch.ts         — publish.dispatch handler: stale-lease reaper + transactional claimNextDeployBatch + fan-out + stub-channel skip.
- verifyIndexing.ts   — publish.verify handler + indexing stamp.
- types.ts            — zod payloads (PublishDispatch/Unit/Verify) + url_registry row types.

EDITS (additive, no signature changes):
- src/scheduler/jobs.ts   — PUBLISH_* JOB_NAMES + DLQ names + zod payload schemas.
- src/scheduler/queue.ts  — add 3 queues + 2 DLQs to the createQueue list.
- src/scheduler/worker.ts — register 3 publish handlers (injected) + publish.dispatch cron.
- src/db/repo.ts          — claimNextDeployBatch / reapStaleLeases / approveDeployRow / markDeployStatus / claimUrlRegistry (ON CONFLICT) / markUrlRegistryPublished / updateIndexingStatus / listPublishedUrlsForMonitoring + throttle counter fns.
- src/db/schema.ts        — UrlRegistryTable, ChannelThrottleTable, ChannelThrottleStateTable; widen ContentDeployQueueTable.
- src/config/env.ts       — OWNED_NET_OUT_DIR, OWNED_NET_HUB_BASE_URL, DEPLOY_DRY_RUN (default true), DEPLOY_LEASE_TIMEOUT_MS, DEPLOY_DEFAULT_MAX_PER_DAY, CUSTOMER_DOMAIN_BLOCKLIST.

NEW src/cli/: approveDeploy.ts (human approval w/ identity), publishContent.ts (manual dispatch, --execute flips dry-run), deployStatus.ts (registry readiness + url_registry/indexing report).

REUSED UNCHANGED: providers/types.ts pattern, scheduler/queue.ts PgBossJobQueue + EnqueueOptions + RetryableJobError/PermanentJobError, content_deploy_queue + uq_deploy_queue_asset, src/content/types.ts ContentBody/JsonLd, the content_asset channel_class enum.

NEW test/deploy/: connector-not-configured, registry-subset-channel-enum (§7#3), no-community-connector, ownedNet-deferred-url, ownedNet-host-blocklist (§0), render-jsonld, throttle-cadence, throttle-transactional-cap, throttle-per-customer, eligibility-regate-flip, approval-failclosed, idempotency-claim-before-publish, idempotency-no-double-publish, dryrun-no-side-effect, disclosure-required-gate, claim-lease-skip-locked, dispatch-skip-stub-channels, owned-net-indexing-not-indexed, verify-indexing-stamp, publish-tracking-readonly.

## Key Decisions

- **ONE idempotency arbiter: partial UNIQUE on url_registry (asset_id, channel_class) WHERE publish_status IN ('publishing','published'). NO connector_version in any key.** — All three reviews flagged Proposal 1's sha256(asset,channel,connector_version) as a literal double-publish vector (a code bump mints a new key). The existing schema (uq_deploy_queue_asset on asset_id, content_asset.channel_class fixed per asset) means (asset_id, channel_class) is the correct natural key. A single partial-unique arbiter lets dry_run/failed/unpublished rows coexist while guaranteeing at-most-one live publish; two competing arbiters (Proposal 3) cause split-brain.
- **CLAIM-before-side-effect: insert publish_status='publishing' with ON CONFLICT DO NOTHING and proceed to connector.publish() only if rows-affected=1.** — All three proposals ordered artifact-before-ledger; reviews proved a retried job after a successful publish but failed ledger write double-publishes an irreversible channel (pr_wire/entity). Claiming the idempotency record first makes the side effect single-flight even when the channel API is non-idempotent.
- **§7#5 throttle enforced transactionally inside the claim (row-locked channel_throttle_state), not via a separate live COUNT.** — Proposals 2/3 admitted a count-then-publish race ('not a hard transactional guarantee') and dual-dispatcher over-lease. For the first side-effecting phase the cap must be a hard fail-closed gate; binding the cap check + counter increment + lease into one SKIP LOCKED transaction (Proposal 1's same-tx instinct, fixed) closes the race.
- **Per-customer throttle and url_registry.customer_id are JOINed/copied from content_asset; the queue is NOT given a customer_id; NULL-customer (generic owned-net) is a real COALESCE bucket.** — All reviews verified content_deploy_queue has columns id, asset_id, channel_class, status, created_at only — no customer_id. disclosure_tag and customer_id live on content_asset. A purely per-channel-global throttle violates §7#5 naturalness across tenants; the COALESCE bucket prevents generic owned-net assets from being silently dropped from per-customer accounting and the §3 handback.
- **owned_net resolves the EXISTING Phase 2 deferred token {deferred:true,role:'owned_hub'} against config; never accepts a free-form URL string; plus a fail-closed CUSTOMER_DOMAIN_BLOCKLIST guard at two layers.** — Reviews noted all three proposals regressed from Phase 2's STRUCTURAL §0 guarantee (DeferredUrlSchema makes a customer domain unrepresentable) to a runtime assertion against a configurable base URL. Resolving the token (which carries no slug/industry/language) and deriving the slug from the asset row keeps the customer domain structurally unrepresentable; the blocklist is defense-in-depth.
- **Publish tracking is strictly read-only feedback: Phase 3 writes url_registry only; NO cycle.plan edit and NO auto-seeding of monitoring questions from published phrasings. Consumer deferred to Phase 4.** — Proposal 3's handoffToMonitoring (upsertQuestion seeding + run annotation) was unanimously flagged as measurement-gaming that fabricates §14 lift and bypasses the §5.5 human question gate — close to a §7#3 fake signal at the data layer. A read-only contract keeps the loop closeable without coupling write paths.
- **owned_net file-presence maps indexing_status to 'submitted'/'unknown' only — NEVER 'indexed'.** — A local FsTarget file is not crawlable; reviews warned that feeding 'indexed' into the Phase 0 monitor would mis-attribute SMR lift to a URL no engine can see (§7#3 at the data layer). Real indexing confirmation is Phase 4 SERP/Indexing API, ToS-respecting (no raw scraping, §12).
- **Human approval is a NEW mandatory fail-closed step with approver identity: approved_by/approved_at on content_deploy_queue; queuePassedAssets keeps inserting status='queued' with approval NULL.** — Reviews verified queuePassedAssets sets no approval, so every queued row lands not-approved (correctly not-eligible until approveDeploy CLI signs). A bare boolean is insufficient for §11/§12 audit; capturing approver identity + timestamp gives a tamper-evident trail. This changes the Phase 2 operational contract and is documented explicitly.
- **NOT_CONFIGURED stub channels are SKIPPED at dispatch (registry.readiness filter); rows stay 'queued', never enqueued or DLQ'd. No queue 'dry_run'/'deferred' status.** — Reviews showed Proposal 1's terminal 'skipped' loses content, and Proposal 2's both-DLQ-and-reset-to-queued creates an infinite re-claim/re-fail loop against the existing DEAD_LETTER_ERROR_CODES. Skipping at dispatch keeps eligible content recoverable when keys arrive; keeping dry_run/deferral out of the queue status lifecycle prevents stranding rows outside the claim predicate.
- **Disclosure is a fail-closed code gate: BLOCK publish to external channels (pr_wire/directory/web2/social) when disclosure_tag IS NULL; owned_net may be null.** — disclosure_tag is nullable on content_asset (verified). §7#6 requires sponsored/affiliate disclosure on external channels; merely carrying a null tag through is a compliance gap. Only Proposal 3 had a partial gate — made mandatory and complete here.
- **ONE migration 0010_phase3_deploy.sql (PLAIN tables + ALTER), transactional .sql; DROP+re-ADD the content_deploy_queue status CHECK.** — All new tables are bounded ledgers/config kept PLAIN to dodge the TimescaleDB partition-col unique-index rule (same reasoning as Phase 2 content_asset), so no .cjs is needed. The CHECK swap is the one non-trivial DDL step; verified no Phase 0/2 test pins the single-value 'queued' CHECK (queueForDeploy and its tests only insert status='queued').
- **PR-wire syndication child URLs are explicitly OUT OF SCOPE of the (asset_id, channel_class) arbiter; deferred to a future separate syndication-children table.** — Reviews showed N child URLs sharing (asset_id, channel_class='pr_wire') cannot coexist under the partial-unique without reopening the at-most-one-real-publish guarantee. Deferring avoids baking a self-contradicting fan-out model into the schema now (pr_wire is a stub anyway).

## Implementation Tasks

| id | pg | dependsOn | title |
|----|----|-----------|-------|
| T01 | 1 | — | Scaffold src/deploy module + env config additions |
| T02 | 1 | — | Migration 0010 — url_registry, channel_throttle, channel_throttle_state, ALTER content_deploy_queue |
| T03 | 2 | T02 | Extend schema.ts with Phase 3 tables + widen ContentDeployQueueTable |
| T04 | 2 | T01 | ChannelConnector interface + PublishResult union + ChannelClass |
| T05 | 3 | T03 | Repo functions — claim/lease, approval, url_registry claim+publish, throttle counter, monitoring read |
| T06 | 3 | T04 | Generic StubConnector + ChannelRegistry with deny-default + readiness |
| T07 | 3 | T04 | OwnedNetConnector + OwnedNetTarget(FsTarget) + deferred-url resolver + §0 host guard |
| T08 | 3 | T04 | External channel stub connectors (prWire, directory, web2, social, entity) |
| T09 | 4 | T05 | Naturalness throttle decision module (§7#5) |
| T10 | 4 | T04 | Eligibility + disclosure gates (pure) |
| T11 | 2 | T01 | Job names, payloads, DLQs + queue registration |
| T12 | 5 | T05,T06,T07,T08,T10,T11 | publish.unit handler (claim-before-publish, dry-run, idempotent) |
| T13 | 5 | T05,T06,T09,T11 | publish.dispatch handler (reaper + transactional claim + stub skip + fan-out) |
| T14 | 5 | T05,T06,T11 | publish.verify handler (indexing stamp) |
| T15 | 6 | T12,T13,T14 | Wire publish handlers + dispatch cron into worker.ts |
| T16 | 6 | T05,T06,T13 | CLIs — approveDeploy, publishContent, deployStatus |
| T17 | 7 | T06,T08 | Connector/registry/§7#3 tests |
| T18 | 7 | T07 | owned_net §0 + render + dry-run + indexing tests |
| T19 | 7 | T09,T10,T05 | Throttle, eligibility, approval, disclosure gate tests |
| T20 | 7 | T12,T13,T14 | Idempotency, claim-lease, dispatch-skip, verify, read-only-feedback tests |
