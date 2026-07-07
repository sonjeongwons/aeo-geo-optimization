---
name: project-aeo-geo-quality-overhaul
description: The 2026-07 total-quality overhaul — Phase-1 audit roadmap (W1-W10) and which workstreams are shipped vs remaining
metadata: 
  node_type: memory
  type: project
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
---

On 2026-07-04 the owner asked for a total AEO/GEO service-quality uplift (UX, content, SEO/AEO/GEO, readability, expressiveness) run as a dynamic workflow with cross-checking agents. See [[feedback-workflow-model-split]].

**Phase 1 (done):** a workflow (21 agents) did external SOTA research (GEO paper statistics/quotation levers, llms.txt is a dud, robots/IndexNow/RSS discovery, measurement rigor) + a 7-dimension adversarially-verified internal audit → a prioritized roadmap W1-W9 + a completeness critique. The critique's biggest flag: the roadmap narrowed the product to "a well-rendered owned-net hub + honest measurement" and omitted **off-site distribution (W10)** — SPEC §2/§8/§14 make PR-wire/directory/entity/Web2/social first-class, and ~85% of AI brand mentions originate off-site. Recommendation-share is also under-surfaced.

**Shipped (each committed + tested, one adversarially reviewed):**
- render.ts overhaul: CJK-aware CSS/dark/responsive, short pipe-safe h1, DefinedTerm/author/case_study JSON-LD, OG tags, renderRobots (W4/W5). Adversarial reviewer caught 4 real P1s (pipe leak, ragged table, empty h1, delimiter fallback) → fixed.
- hub index: shared CSS, single-escaped titles, robots.txt + RSS feed.xml emit (W5.3/W9.1/W9.3), full-ISO sitemap lastmod (W9.4).
- content quality: always-on comparison-table discipline + §0 no-facts guard, per-script geoReadiness length band (W6.2/W6.3).
- email honesty (scripts/email-report.mts — the LIVE owner email): Wilson 95% CIs, low-power badge, honest measured-engine label, drift disclosure (W2/W8.4).
- dashboard W7: dead evidence button wired, brand-vs-competitor §7 label fix, formatPct NaN guard + StatCard emphasis, mobile, nav/focus/loading/error.

**W1 honesty-gate plumbing (owner-chosen, in progress):**
- DONE W1.1 (commit bc54b47 + review-hardening 316a49e): claimVerificationGate now writes verifyAndDecide's resolved claims back onto ctx.asset.claims; assembleContentSet + regateAsset persist them. This is the self-heal-loop root cause fix — re-gating now re-resolves persisted claims for $0. Adversarial review = PASS/ship-safe.
- W1.3 SUBSUMED by W1.1 (do NOT swap reviewClaims to the production registry — breaks the documented $0 re-gate guarantee; the no-adapter gate re-resolves persisted claims correctly).
- **CRITICAL for W1.2 (deferred, high-risk): the cheap gates (verifiableNumbers/noFakeSignals/jsonLdShape) treat a claim as "covered" by `resolved_source_id!=null` ALONE. W1.1 now persists resolved_source_id on needs_human/rejected claims, so this is §7-safe ONLY because claimVerificationGate runs LAST. When W1.2 reorders the binder earlier it MUST switch those gates to the new `isClaimVerified(claim)` helper (claimVerify.ts) — a naive swap NOW would break the numeric re-gate flip (cheap gate sees stale needs_human before the binder re-derives). See §7 INVARIANT comments in those 3 gate files.**
- Remaining W1: W1.2 (reorder/relax block→needs_human, high-risk), W1.5 (ingest owner-attested numbers/quotes — needs owner data), W1.6 CJK numeral value-binding, W1.7 superlative substrings, W1.9 trilingual fake-signal/injection lexicons, W1.10 keyword-overlap cross-bind guard. W4.2 (visible citations) unblocks once claims persist + owner facts exist.
- **W3 surface citation wiring** — judge reads structured provider_meta.citations; capture Perplexity/OpenAI citation arrays. Needs API keys to fully test.
- **W9.2 IndexNow** — external submission (needs owner opt-in + key).
- **W10 off-site channel connectors + recommendation-share headline** — the strategic gap; needs owner accounts + FTC/표시광고법 disclosure + human-ops.

**2026-07-04 session 2 additions:**
- Shipped: W1.1 claim persistence + W1.7 CJK superlative fix + W1.9 trilingual fake-signal/injection lexicons + W1.10 generic-noun cross-bind guard + W9.2 IndexNow (gated) + W4.2 references render capability + FAQ-open/anchors + dateModified decouple + ItemList JSON-LD (comparison). Email honesty (Wilson CI etc.) + dashboard W7 shipped in session 1.
- CANONICAL CUSTOMERS (ids verified vs live DB): **EMORA = slug `emora`, id `3cb680d5-190d-4485-b456-4c645a91a16a`, active template `ai-companion`, 161 claim_sources**. **SMIM = slug `smimdate`, id `f9d13b5c-32c7-4e89-ada4-7a7a876882d1`, active template `rotation-dating`, 17 claim_sources**. (`emora-mini` 5179c0f3 is ORPHANED — don't use.) publish.yml/measure.yml/email-report all point at these now; they previously held STALE non-existent ids (the real cause of "0 generated content").
- Owner-directed fact extraction from OWN domains (tryemora.com, smimdate.com) — owner-authorized §0 exception (owned domains only). §7-EXCLUDED: EMORA site's 4.8/5 rating+reviews + "Sarah K." testimonial (fake signals); HELD pending verifiable source: hero counters (10k users etc., 표시광고법 risk).
- Both live hubs (EMORA aeo-owned-net-hub 19pp, SMIM aeo-smim-hub 7pp) re-rendered live with CSS/JSON-LD/robots/feed (fixed a live raw-markdown-table bug).
- Free-tier Gemini key: daily quota exhausts fast → generation deferred to reset (owner OK).
- NET-NEW exploration backlog (session 2, not yet built): TOP LEVER = passage-structured rendering + **leading indicators: embedding retrievability scorer (src/metrics/retrievability.ts, adapter-gated) + faithfulness/NLI gate (claimEntailment.ts, mDeBERTa-xnli)**. Also: semantic dedup, SMR→IntentMatrix feedback loop, per-engine readiness scorecard, Bing Webmaster AI Performance (free 2nd measurement channel — needs owner property verification), fail-closed multilingual lexicons.

See [[project-aeo-geo-phase0]] and [[reference-korean-claim-binding]] (the CJK numeral gate gap is W1.6, still deferred — §7 mis-scaling risk on word fragments).
