# SOTA Sweep v6 — adversarial SELF-AUDIT over freshly-shipped code + frontier scan

Source: dynamic workflow `aeo-geo-sota-sweep-v6` (**28 agents, ~1.08M tokens**). Design: 3 **diverse-lens self-audit finders** (adversarial-input / statistical-correctness / integration-contract) pointed at the code shipped earlier THIS session (X12/X22/X25/W4 + all v5 P0-fix files), plus 3 frontier finders (arXiv-GEO / GitHub-HF / patents-reg) → map/dedup → adversarial critic (each claimed bug RE-VERIFIED in the live source before clearing) → synthesis.

**24 raw → 20 deduped → 6 cleared — and all 6 cleared are VERIFIED self-audit bugs** in code shipped this session. The frontier findings were all dropped as duplicates of shipped/queued work (the roadmap is now dense). This is the strongest signal yet that the self-audit lens, not the frontier scan, is where the marginal value is at this maturity.

---

## BUG FIXES (self-audit found + critic-verified; ✅ ALL 6 APPLIED + regression-tested)

Regression locks: `test/sweep-v6-self-audit-fixes.test.ts` (13 tests) + 3 corrected `judgeReliability` assertions.

| Bug | File | What was wrong | Fix |
|-----|------|----------------|-----|
| **Y1** (P0) **ReDoS** in title domain extraction | `src/judge/groundingGap.ts` | `BARE_DOMAIN_G = /…[a-z0-9-]*[a-z0-9]…/` backtracks **quadratically** on an adversarial hyphen-heavy Gemini chunk title, synchronously stalling the grounded-answer aggregation hot path. | Per-label-BOUNDED regex (`[a-z0-9-]{0,61}` — DNS labels can't re-partition) + a 2,000-char title scan cap. Real domains still match. |
| **Y2** (P0) **recommendationShare false negatives** | `src/judge/recommendation.ts` | `stripQuoted`'s `/'[^']*'/g` treated the apostrophes in **two contractions** as a quoted span — `"I'd recommend EMORA, it's the best"` → blanked `'d recommend EMORA, it'` → erased the brand+verb → not counted. Deflated the headline metric on natural English. | Boundary-delimited single-quote rule `/(^|[^A-Za-z0-9])'([^']*)'(?=[^A-Za-z0-9]|$)/` — contraction apostrophes (preceded by a letter) never open a span; genuine quoted spans still strip. |
| **Y3** (P0) **keyword-stuffing gate is a no-op on CJK** | `src/content/gates/keywordStuffing.ts` | The `/[a-z0-9']+/g` tokenizer matches **zero** CJK chars, so `total < 50` is always true and the gate never fires on Korean/Japanese — ~2/3 of supported locales unguarded. | CJK-aware `significantTokens`: Latin words as before **plus** overlapping CHARACTER BIGRAMS from each Han/Hiragana/Katakana/Hangul run, so an over-repeated CJK term surfaces as a high-frequency bigram. Conservative thresholds unchanged. |
| **Y4** (P0) **judge-AC1 honesty-contract violation** | `src/judge/judgeReliability.ts` | `certifyJudge` returned `ac1: null` for `1≤n<minN`, contradicting its own JSDoc + the inline "null only when n===0" comment, and breaking symmetry with `prevalence` (surfaced at the same n). | Return the COMPUTED `ac1` (null only at n=0); `status: not_measurable` + the `note` remain the honesty gate. 3 self-contradicting agent-authored test assertions corrected. |
| **Y5** (P1) **wrapper misclassification on URI path** | `src/judge/groundingGap.ts` | `isWrapper = host.includes(w) || uri.includes(w)` — the `uri.includes` half matched the **path**, so a real cited source whose path contained the generic slug `grounding-api-redirect` was discarded as a wrapper. | Classify on the **host** only; fall back to the raw uri only when the host is unparseable. Real wrappers (`vertexaisearch…`, `googleusercontent.com`) still caught by host. |
| **Y6** (P0) **FTC anti-persona over-fire** | `src/content/gates/noFabricatedPersona.ts` | The intro-persona pattern's qualifier was OPTIONAL, collapsing to `"Meet <Capitalized word>"` and **blocking benign owned-net copy** ("Meet Slack integration…", "Meet European compliance standards…") → cut yield. | Split into a union: `"Meet our customer <Name>"` (explicit) **and** `"Meet <Name>"` only when immediately followed by a comma/period or a testimonial verb. Bare "Meet Sarah," intros + the customer form still blocked; benign noun copy passes. |

**Lesson (3rd sweep in a row):** the self-audit lens caught real bugs that all-green mocked tests missed — this time **in code written minutes earlier**, including bugs in a Sonnet-agent module whose OWN tests encoded a contract that contradicted its OWN JSDoc (Y4). Diverse audit LENSES (adversarial-input / statistical / integration) surfaced different bug classes than a single auditor would. Keep multi-lens self-audit as the primary sweep mode at this maturity; the frontier scan is now mostly duplicate.

## Frontier findings
All dropped at map/critic as duplicates of shipped/queued work (R-series, V-series, W-series, X-series already cover the live GEO/citation/attribution/judge-calibration literature). No new external technique survived — a sign the roadmap is saturated for now.
