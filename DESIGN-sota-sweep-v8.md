# SOTA Sweep v8 — focused multi-lens SELF-AUDIT over X10 + X16

Source: dynamic workflow `aeo-geo-sota-sweep-v8` (**8 agents**). Design: 3 adversarial lenses (statistical-correctness / adversarial-input / honesty-contract) over the two pure modules shipped earlier this turn (X10 varianceComponents, X16 citationPosition) → map/dedup → critic (each bug re-derived / traced in the source) → synthesis.

**5 raw → 3 deduped → 3 CONFIRMED bugs — all in X10.** X16 (citationPosition) came back **clean** under all three lenses. The implementing model here was Opus (direct), and the audit still found a P0 honesty bug — confirming that self-audit is worth running even on carefully hand-written statistical code.

---

## BUG FIXES (self-audit found + critic-verified; ✅ ALL 3 APPLIED + regression-tested)

Regression lock: `test/sweep-v8-self-audit-fixes.test.ts` (4 tests); all 25 pre-existing X10/X16 tests still pass.

| Bug | Sev | What was wrong | Fix |
|-----|-----|----------------|-----|
| **Z1** | **P0** | `dStudy` never inspected `vc.estimable`. A non-estimable design (P<2, or no prompt with n≥2) returns σ²=0 placeholders → `predictMeanSe` returns **0** → `samplingAdequate = (0 ≤ targetSe) = true`, **certifying a degenerate design as a perfect zero-SE estimate** needing only 1 prompt × 1 run. Directly contradicts the module's honesty note. | Guard at the top of `dStudy`: when `!vc.estimable` return `currentSe: Infinity, samplingAdequate: false, recommended* : null` — an unidentifiable variance is unknowable, never adequate. |
| **Z2** | P2 | The validity filter checked bounds (`hits ≤ n`) but not integrality. A fractional/averaged tally like `{hits:2.5, n:3}` passed, silently breaking the binary within-prompt SS identity `SSW_p = n·p̂(1−p̂)` (valid only for a true 0/1 vector) and corrupting σ²_resid + everything downstream. | Require `Number.isInteger` on both `hits` and `n` (drop malformed tallies like the existing `hits>n` drop). |
| **Z3** | P2 (doc) | `DStudy.currentSe` JSDoc presented the value as the realized SE, but it is computed with the BALANCED formula while the fit is on UNBALANCED data (realized SE for unequal n_p is σ²_prompt·Σn_p²/N² + σ²_resid/N). | Redocumented `currentSe` as a balanced PROJECTION (the interface takes scalar P,n so it can only express a balanced design), matching `predictMeanSe`'s disclosure. |

---

## Lesson (5th consecutive sweep)
The orchestrator wrote X10 directly (Opus) with deliberate statistical care — and the audit STILL found a P0 honesty bug (`dStudy` certifying an unidentifiable design as perfect). Two reinforcements: (1) **careful authorship is not a substitute for adversarial audit** — the estimable-guard gap was a composition error (`estimateVarianceComponents` correctly flags `estimable=false`, but `dStudy` ignored it) that no single-function review would surface; (2) X16 being clean shows the audit isn't crying wolf — it confirms clean modules and finds real bugs in dirty ones. The clean/confirmed split (X16 clean, X10 3-for-3 confirmed, all critic-verified) is the signal that the loop is calibrated, not noise.
