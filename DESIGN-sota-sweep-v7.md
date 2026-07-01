# SOTA Sweep v7 — focused multi-lens SELF-AUDIT over the freshly-shipped M-tier modules

Source: dynamic workflow `aeo-geo-sota-sweep-v7` (**17 agents, ~0.44M tokens**). Design: 4 **diverse adversarial lenses** (numeric-correctness / adversarial-input / honesty-contract / integration-contract) pointed ONLY at the four pure modules shipped earlier this turn (X9 sourceStability, X11 judgeDebias, X18 citationFailureStage, X30 confidenceSequence) → map/dedup → critic (each claimed bug traced through the source with a concrete failing input before confirming) → synthesis.

**16 raw → 11 deduped → 8 CONFIRMED bugs.** The headline: a **P0 math/honesty error in code generated from MY OWN (Opus) spec** — the anytime-valid guarantee was mathematically false. X18 (failure-stage) came back **clean**.

---

## BUG FIXES (self-audit found + critic-verified; ✅ ALL 8 APPLIED + regression-tested)

Regression locks: `test/sweep-v7-self-audit-fixes.test.ts` (11 tests); all 103 pre-existing M-tier tests still pass under the corrected behavior.

| Bug | Sev | File | What was wrong | Fix |
|-----|-----|------|----------------|-----|
| **Z1** | **P0** | confidenceSequence.ts | The radius `h(n)=sqrt(log((n+1)/α)/(2n))` has per-look failure budget `2α/(n+1)`, which sums **divergently** (harmonic) — so `P(∀n: θ∈CS(n)) ≥ 1−α` is **FALSE**. The module's headline "anytime-valid" guarantee was a lie and `crossedZero` gave peeking customers an inflated false-positive rate. The two-arm RSS combination was also too narrow. | Honest **union-bound CS**: allocate `α_n = 6α/(π²n²)` (Σ=α) → `h(n)=sqrt(log(π²n²/(3α))/(2n))`. Two arms: split **α/2** per arm + combine **additively** (triangle inequality) for a true 1−α joint guarantee. Doc rewritten to describe the actual construction. |
| **Z3** | P1 | judgeDebias.ts | `nObs≤0` → all variance terms 0 → **zero-width 95% CI from zero observations** (fabricated certainty). | Guard: return the point estimate with `ciLow/ciHigh = null` + an honest note (mirrors the non-identifiable branch). |
| **Z4** | P1 | judgeDebias.ts | Wald `Var(p_obs)=p(1−p)/n` is **exactly 0 at p_obs∈{0,1}** → zero-width CI from 50 real observations. | **Agresti-Coull** adjusted variance (`acP=(p·n+2)/(n+4)`, `var=acP(1−acP)/(n+4)`) — stays positive at the boundary, matching the codebase's Wilson-over-Wald preference. |
| **Z6** | P1 | judgeDebias.ts | The calibrated note hardcoded **"95 %"** while the bounds used the caller's `z` — a z=2.576 (~99%) interval was mislabeled 95%. | Derive the level from z via a compact erf/`normalCdf` → `confidenceLevelPct(z)`; emit the true percentage. |
| **Z2** | P2 | confidenceSequence.ts | `pointEstimate = successes/n` unclamped → `proportionCS(10,5)` returned `{lower:1.31, upper:1}` (inverted, out of [0,1]). | Clamp the point estimate (and pA/pB) to [0,1] — a no-op on valid `0≤successes≤n` rows. |
| **Z8** | P2 | confidenceSequence.ts | No alpha-domain check → `alpha≥n+1` made `log(…)≤0` → NaN silently masked into a full interval. | `assertAlpha`: throw `RangeError` when `alpha∉(0,1)`, mirroring sourceStability's guard. |
| **Z9** | P2 | sourceStability.ts | `gini()` only guarded empty/all-zero → negative/non-finite counts produced out-of-[0,1] or NaN. | Reject negative/non-finite values → `null` (matches the module's return-null convention). |
| **Z11** | P2 (doc) | sourceStability.ts | The `rbo` `maxScore` comment claimed `1−p^k` (wrong by a `(1−p)` factor); the code was correct. | Comment corrected to `Σ p^(d-1) = (1−p^k)/(1−p)`. |

---

## Lesson (4th consecutive sweep; the sharpest one yet)
The self-audit caught a **P0 correctness/honesty bug seeded by the orchestrator's OWN specification** — I (Opus) handed the implementing Sonnet agent a radius formula that is not anytime-valid, the agent faithfully implemented it AND wrote tests that passed, and only the adversarial **numeric-correctness lens** (which re-derived the per-look budget Σ=2α/(n+1) and saw it diverge) caught it. Takeaways: (1) a confident spec is not a correct spec — **audit the design, not just the code**; (2) diverse lenses matter — only the math lens would have found Z1, only the honesty lens found Z6; (3) "all tests pass" is the *start* of verification at this rigor level, not the end. Self-audit remains the primary marginal-value mode; the frontier scan is now consistently duplicate (roadmap saturated).
