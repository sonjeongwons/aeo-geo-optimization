# Hi-End Elevation Roadmap (multi-agent audit, 2026-06-26)

Source: 8-dimension parallel code audit (Explore agents, real files) → adversarial verification → Opus synthesis.
33 agents, 73 findings, 21 high-impact confirmed real. Run: wf_29bd2664-531.

## Verdict
A genuinely working, §0/§7-disciplined off-site AEO/GEO engine with **correctness hygiene well above MVP (in places best-in-class)** — but it sits at "strong Phase-0 beta" because (1) the whole value prop is measured through a **Gemini-only judge** (cites ~8% of answers) and the 2nd-engine judge is **implemented but dead code**, and (2) distribution is a **single real connector** (FsTarget→GitHub Pages) with 5 stub connectors and no CDN/IaC/CI-CD.

## ALREADY WORLD-CLASS (do not touch)
- Structural §0: deferred-URL token makes the customer domain literally unrepresentable + assertNotBlocklisted fail-closed defense-in-depth.
- §7 honesty discipline: confirmIndexing returns indexed:false (no fake signal); measurement disclosure admits single-engine + mention-vs-citation limits; evidence-required guardrails.
- Deterministic mention correctness: NFC + diacritic-fold rule fallback, shared rank rule (domain/rank.ts), intra-cycle cache isolation.
- Clean seams: ProviderAdapter + OwnedNetTarget interfaces — multi-engine/multi-channel hard work done; only WIRING missing.
- Fail-closed cost/budget ledgering; SSRF-hardened pinned fetch.

## MUST (correctness / security / §7-honesty) — contained changes
1. **Judge pluggability (TRANSFORMATIVE)** — `src/index.ts` hardcodes `registry.get('gemini')` for judging (≈lines 136-137, 258-259). `openaiCompat.judge()` is fully implemented + registry flips perplexity/openai to 'ready' on key — but nothing selects them, so **adding PERPLEXITY_API_KEY changes nothing**, and the disclosure's "independent judge will be substituted" is **false in code**. Fix: `JUDGE_PROVIDER(S)` in env.ts → `resolveJudgeAdapters(registry, env)` → run N judges in extractMention → record judge_provider + report per-judge SMR + cross-judge agreement %.
2. **Split MENTION vs CITATION** — JudgeVerdict has only brand_mentioned; we sell citation/traffic but measure name absorption under "Share of Voice". Add citation_present/url/quote to JudgeVerdictSchema + buildJudgeSystemPrompt + ruleFallback (detect [text](url) with aliases) → SMR_mention vs SMR_citation in aggregate.ts.
3. **Confidence intervals + sample adequacy** — computeSMR/Visibility/SoV return bare scalars. Add Wilson 95% interval; flag n<30/question, n<100 global. Point estimates without bounds = statistical malpractice + blocks A/B.
4. **Baseline-vs-operating delta + significance** — run.kind exists but no compareRuns(). Add baseline_run_id FK + computeRunDelta() with Fisher exact + bootstrap CI → {delta, ci, p_value, is_significant}. "We lifted SMR by X%" must be validated.
5. **REPORT_TOKEN_SECRET hardening (SECURITY)** — reportToken.ts falls back to a hardcoded dev secret when NODE_ENV!=='production', and the secret isn't in env.ts (lazy-validated). A misconfigured deploy → public HMAC key → permalink forgery / cross-customer report IDOR. Make it required min-32-byte in env.ts (fail-fast); gate dev fallback behind explicit flag.
6. **Append-only security_audit table** — approvals scattered (claim_source.verified_by, content_deploy_queue.approved_by, url_registry.approver_audit), no immutable trail. Add security_audit(event_type, actor, resource, ts, details, result); §12/SOC2 control gap.
7. **Guardrail-health + abstain alerting (S, high leverage)** — computeAbstainStats counts but never thresholds. If 30-40% abstain, SMR denominator leaks + residual sample biased. Add healthMetrics with WARN>0.2/CRITICAL>0.4 + customer-facing "measurement quality" line.

## HIGH (transformative leverage)
8. **S3+CloudFront OwnedNetTarget** (seam exists, zero connector/test change) + IaC + cache invalidation → real production-indexable CDN (FsTarget is honestly uncrawlable).
9. **Evidence-dense JSON-LD** from verified claim_source: extend JsonLdBody with stats[]/quotation/citations[]; real datePublished/dateModified; block date-bump-without-change. (Note: articleJsonLd EXISTS but datePublished:null.)
10. **Gemini per-call timeout + provider circuit breaker** (OpenAI adapter already has AbortController 30s; Gemini has none).
11. **Per-engine citation-budget normalization** for honest cross-engine SMR/SoV (once 2nd judge lands).
12. **Self-containedness gate → actionable alias suggestions + targeted-rewrite regen loop** (currently detects but gives no fix path).
13. **Instrument claim-extraction yield + gate decisions** — turn the paid §7#7 gate from faith-based to data-driven; locate the real yield bottleneck (extractor vs model vs unseeded sources).

## MEDIUM (production-scale / enterprise; correctly deferred behind MUST/HIGH)
- Prometheus/OTel /metrics (queue depth, p99, DLQ). · Queue-depth backpressure + pollingIntervalSeconds. · Env-driven pool sizing + cron leader election (multi-replica). · Dashboard API rate limiting (429) defense-in-depth. · Per-channel length bands + per-language prompt tuning (yield). · PII/stack scrubbing in pino. · runResponse atomic transaction (kill ghost response_raw). · Deadlock 40P01 retry→DLQ.

## POLISH
- Configurable extraction model/temp via FeatureFlag. · §0 blocklist IPv6/CNAME/wildcard hardening (defense-in-depth). · env provider-key length guards + missing-secret startup audit. · Disclosure-tag variant A/B. · Temperature-variance / rank-stability for Priority Gap. · Evidence audit trail (sample+persist evidence_quote). · Phrasing-variation per-template thresholds + cross-format exemptions.

## TOP-5 TO DO FIRST (highest ROI, in order)
1. Judge pluggable + wire openaiCompat.judge() as co-judge (env JUDGE_PROVIDER + replace 2 hardcoded gemini gets in index.ts). **#1 — every SMR flows through a 92%-zero-citation instrument; disclosure is false in code.**
2. Split MENTION vs CITATION (measure the business outcome).
3. Wilson CIs + sample adequacy + baseline-vs-operating significance test.
4. Harden REPORT_TOKEN_SECRET (IDOR footgun).
5. S3+CloudFront OwnedNetTarget (+IaC) — real indexable CDN.

## BIGGEST GAPS TO TOP-TIER
Single-engine measurement (dead 2nd judge) · no statistical rigor (no CIs/significance) · measures MENTION but sells CITATION · single real channel (5 stubs, no CDN/IaC/CI) · thin observability + compliance audit trail · under-exploited content evidence-density (minimal JSON-LD, no-fix self-containedness).
