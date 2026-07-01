# SOTA Sweep v9 — multi-lens SELF-AUDIT over the final roadmap batch (X23/W1/W6/W7/W2)

Source: dynamic workflow `aeo-geo-sota-sweep-v9` (**13 agents, ~0.47M tokens**). 4 adversarial lenses (numeric-correctness / adversarial-input / honesty-contract / integration-contract) over the five modules shipped this turn → map/dedup → critic (each bug re-derived / traced in source) → synthesis.

**10 raw → 7 deduped → 3 CONFIRMED bugs — all §7 honesty-contract violations.** W6 (audit-chain verifier) and the W2 surface wiring came back **clean**.

---

## BUG FIXES (self-audit found + critic-verified; ✅ ALL 3 APPLIED + regression-tested)

Regression lock: `test/sweep-v9-self-audit-fixes.test.ts` (8 tests); all pre-existing X23/W1/W7 tests still pass.

| Bug | Sev | File | What was wrong | Fix |
|-----|-----|------|----------------|-----|
| **Z2** | **P1** | botAccessibility.ts | `isAllowed` used a BIDIRECTIONAL prefix test (`ua.startsWith(agent) \|\| agent.startsWith(ua)`). The reverse branch let a group written for a longer, distinct token (`ClaudeBot-Special: Disallow /`) capture a shorter tracked bot (`ClaudeBot`) and **outscore the correct `*` fallback**, returning disallowed instead of allowed — corrupting the accessibility corpus metrics. | Forward-prefix only per **RFC 9309 §2.2.1** (a group applies when the robots token is a prefix of the crawler UA; exact match subsumed). Removed the reverse disjunct. |
| **Z4** | P2 | driftControl.ts | The Wald variance `p̂(1−p̂)/n` is identically **0 at p̂∈{0,1}**, so saturated cohorts (e.g. targeted 100/100, holdout 0/100) collapsed the DiD CI to a **falsely exact [0,0] with lowPower:false** — overstating certainty. (Same failure mode as v7 Z4 in judgeDebias.) | Agresti-Coull adjusted variance `((h+2)/(n+4))·(1−…)/(n+4)` at saturated cells → non-degenerate CI. Additive to the documented lowPower (n<minN) semantics. |
| **Z5** | P2 | ttfc.ts | `kmPercentile` compared `F >= p` with no tolerance; `F` is built by repeated subtraction, so an F mathematically equal to p can land just below (`1−(1−1/10)=0.0999…8 < 0.1`), **dropping or shifting an exactly-reachable percentile** (violating the "smallest t with F≥p" contract). | `F >= p − 1e-9` — 1e-9 is far below any meaningful percentile resolution, so the genuinely-censored null-below-p case is preserved. |

---

## Lesson (6th consecutive sweep)
Two of the three bugs are the SAME class we've now seen repeatedly — a boundary/precision degeneracy that produces a **falsely confident number** (Z4 is literally the v7 judgeDebias Wald-variance bug recurring in a different module; Z5 is the float-boundary sibling). The recurrence is the signal: **boundary proportions (p̂∈{0,1}) and float-equality comparisons are a standing failure pattern in this codebase's statistics** — worth a proactive grep across every variance/percentile computation rather than waiting for the next sweep. W6/W2 being clean (a hash-chain verifier written to be paranoid, and surface wiring that mirrors a proven pattern) again shows the audit is calibrated, not indiscriminate.

### Proactive sweep of ALL Wald-variance sites (done this turn, per the lesson)
Grepped every `p(1−p)/n` computation in `src/`:
- **significance.ts:122 / metrics.types.ts:45** — these are the WILSON interval (`p(1−p)/n + z²/(4n²)` under the sqrt, over the `1+z²/n` denom), which is boundary-ROBUST by construction (non-degenerate at p=0/1). Correct — no fix.
- **driftControl.ts:98** — fixed here (Z4).
- **judgeDebias.ts:213-214** (`varSe`, `varSp`) — 0 at se/sp=1, BUT the dominant `varPobs` term is already Agresti-Coull-guarded (v7 Z4), so the CI never collapses to [0,0]; the Se/Sp terms only mildly understate at exact saturation. Not a [0,0] bug — logged as a minor future refinement, not changed unaudited mid-cycle.
Conclusion: no remaining [0,0]-collapse bug; the pattern is now contained.
