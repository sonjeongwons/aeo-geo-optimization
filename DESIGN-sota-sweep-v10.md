# SOTA Sweep v10 — self-audit over the report/dashboard wiring (engineOverlap X25 + samplingAdequacy X10)

Source: dynamic workflow `aeo-geo-sota-sweep-v10` (**7 agents**). 3 lenses (refactor-equivalence / sampling-correctness / honesty-integration) over the wiring that surfaced the X25/X10 pure metrics into `RunReport` + the two dashboard StatCard pages.

**3 raw → 2 deduped → 2 CONFIRMED bugs — both P1 §7 false-certainty defects, both in the wiring shipped this turn.** The `fetchSourceSignals` refactor of `computeEarnedSources` was verified behaviorally equivalent (clean).

---

## BUG FIXES (self-audit found + critic-verified; ✅ BOTH APPLIED + regression-tested)

Regression lock: `test/sweep-v10-self-audit-fixes.test.ts` (3 tests, Z1); Z2 is UI-only (web tsc + review).

| Bug | Sev | What was wrong | Fix |
|-----|-----|----------------|-----|
| **Z1** | **P1** | A CONSTANT binary outcome — **a brand NEVER mentioned (the product's most common baseline, "SMR 0% before")** — is `estimable=true` (P≥2, residual df>0) yet has `σ²_prompt=σ²_resid=0`, so `predictMeanSe` returns 0, `samplingAdequate=(0≤targetSe)=true`, and the StatCard rendered **"표본 적정성 ±0.0% · 목표 충족"** with no caveat — certifying infinite certainty that the true rate is exactly 0. The `!estimable` guard didn't catch it (it IS estimable, just zero-variance). Same boundary-degeneracy class as v7/v9 Z4. | `dStudy`: after the `!estimable` guard, refuse a zero-total-variance design → `currentSe:Infinity` (→ null in the wrapper) + `samplingAdequate:false`. `computeSamplingAdequacy` sets an honest note ("outcome constant 0%/100% — SE not identifiable"). Both StatCards render a dedicated "결과가 상수(0%/100%) — SE 식별 불가" branch. +3 tests. |
| **Z2** | P1 | Both engineOverlap StatCards (overview + the **immutable /r/[token] permalink**) dropped the `lowData` flag that `computeEngineOverlap` sets for engines with < minDomains (3) cited domains. So (1) the render guard admitted a card even when every pair was lowData, (2) the "풀링 가능" ratio counted meaningless 1-vs-1 pairs, and (3) the UNFILTERED `meanJaccard` let high-jaccard lowData pairs suppress the low-overlap caveat for real pairs. | Both pages: render only when `pairs.some(p => !p.lowData)`; compute `reliable = pairs.filter(!lowData)`; base the mean-Jaccard value, the poolable ratio, and the low-overlap caveat on `reliable` only. |

---

## Lesson (7th sweep)
The boundary-degeneracy pattern struck a THIRD time (Z1), and this time on the **single most common real input** — a brand that is never mentioned. That's the key insight: the degenerate case isn't a rare edge, it's the DEFAULT baseline the product exists to move off of, so a false "±0.0% adequate" would ship straight to every new customer's first report. Two standing rules reinforced: (1) any statistic over a binary outcome must be checked at the all-0 / all-1 boundary, because that boundary is the product's starting state, not an exotic edge; (2) UI that renders a metric must carry ALL of that metric's honesty flags (`lowData`, `estimable`, null) through to the render — a metric's honesty contract is only as good as its least-careful consumer, and an immutable signed permalink makes a dishonest render permanent.
