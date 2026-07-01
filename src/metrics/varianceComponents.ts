/**
 * src/metrics/varianceComponents.ts — Feature X10: variance-component
 * decomposition + D-study (Generalizability theory) to BUDGET runs-vs-prompts.
 *
 * PURPOSE
 * -------
 * The shipped `lowPower` flag is binary (n below a fixed floor). It cannot answer
 * the operational question: "given my budget, should I add more PROMPTS or more
 * RUNS-per-prompt to tighten my visibility estimate?" That depends on WHERE the
 * variance lives — between prompts (σ²_prompt) vs within a prompt across repeated
 * runs (σ²_resid). This module decomposes the two and runs a G-theory D-study to
 * (a) replace the binary flag with a Var(θ̂)-driven `samplingAdequacy`, and
 * (b) emit recommendedRunsPerPrompt / recommendedPrompts for a target SE.
 *
 * MODEL (one-way random effects, prompts random):
 *   Y_{pj} = μ + α_p + ε_{pj},   α_p ~ (0, σ²_prompt),  ε_{pj} ~ (0, σ²_resid)
 * estimated by the standard UNBALANCED ANOVA method-of-moments:
 *   σ̂²_resid  = MSW
 *   σ̂²_prompt = (MSB − MSW) / n0,   n0 = (N − Σ n_p²/N) / (P − 1)
 * with σ̂²_prompt clamped at 0 (a negative MoM estimate means no detectable
 * between-prompt variance).
 *
 * HONESTY (§7): the visibility outcome is BINARY (0/1), so these components are a
 * LINEAR-PROBABILITY (ANOVA) APPROXIMATION on the probability scale — adequate
 * for sample-size BUDGETING, but NOT a logistic variance decomposition. This is
 * disclosed in the returned `note`. When the design cannot identify a component
 * (P<2, or no prompt has ≥2 runs) we return estimable=false and DO NOT fabricate
 * a number. Derive from the SAME per-prompt sufficient stats the shipped
 * partial-pooling fit uses; this does not fit a second redundant model.
 *
 * Refs: Cronbach et al. Generalizability theory; Brennan (2001). arXiv 2604.11581.
 *
 * PURE — no IO, no pg, deterministic.
 */

/** Per-prompt sufficient statistics: successes (hits) out of n repeated runs. */
export interface PromptTally {
  hits: number;
  n: number;
}

export interface VarianceComponents {
  /** Between-prompt variance σ²_prompt (clamped ≥ 0). 0 when not estimable. */
  sigma2Prompt: number;
  /** Within-prompt residual variance σ²_resid (MSW). 0 when not estimable. */
  sigma2Resid: number;
  /** ICC = σ²_prompt / (σ²_prompt + σ²_resid); null when total variance is 0 or not estimable. */
  icc: number | null;
  /** Number of prompts P (with n ≥ 1). */
  nPrompts: number;
  /** Total runs N = Σ n_p. */
  nTotal: number;
  /** Unbalanced ANOVA coefficient n0. 0 when not estimable. */
  n0: number;
  /** Grand mean (Σ hits / N), 0 when N=0. */
  grandMean: number;
  /** True when P ≥ 2 AND at least one prompt has n ≥ 2 (residual df > 0). */
  estimable: boolean;
  note: string;
}

/**
 * Decompose visibility variance into between-prompt and within-prompt (residual)
 * components from per-prompt {hits, n} tallies. PURE.
 */
export function estimateVarianceComponents(prompts: readonly PromptTally[]): VarianceComponents {
  // Keep only valid prompts with at least one run.
  // Require INTEGER counts: the within-prompt SS identity SSW_p = n·p̂(1−p̂) holds
  // only for a true 0/1 vector, so a fractional/averaged tally would silently
  // corrupt σ²_resid and everything downstream (v8 Z2). Drop them like hits>n.
  const valid = prompts.filter(
    (p) => Number.isInteger(p.n) && p.n >= 1 && Number.isInteger(p.hits) && p.hits >= 0 && p.hits <= p.n,
  );
  const P = valid.length;
  const N = valid.reduce((s, p) => s + p.n, 0);
  const totalHits = valid.reduce((s, p) => s + p.hits, 0);
  const grandMean = N > 0 ? totalHits / N : 0;

  const notEstimable = (note: string): VarianceComponents => ({
    sigma2Prompt: 0,
    sigma2Resid: 0,
    icc: null,
    nPrompts: P,
    nTotal: N,
    n0: 0,
    grandMean,
    estimable: false,
    note,
  });

  if (P < 2) {
    return notEstimable("Variance components not estimable: need ≥2 prompts to separate between-prompt variance.");
  }
  const dfW = N - P;
  if (dfW <= 0) {
    return notEstimable("Variance components not estimable: no prompt has ≥2 runs, so residual (within-prompt) variance has 0 degrees of freedom. Add repeated runs per prompt.");
  }

  // Between-prompt and within-prompt sums of squares.
  // For a 0/1 vector, the within-prompt SS = n_p · ȳ_p · (1 − ȳ_p).
  let ssB = 0;
  let ssW = 0;
  let sumNsq = 0;
  for (const p of valid) {
    const ybar = p.hits / p.n;
    ssB += p.n * (ybar - grandMean) ** 2;
    ssW += p.n * ybar * (1 - ybar);
    sumNsq += p.n * p.n;
  }

  const dfB = P - 1;
  const msB = ssB / dfB;
  const msW = ssW / dfW;
  const n0 = (N - sumNsq / N) / dfB;

  const sigma2Resid = msW;
  // n0 > 0 always here (P≥2, balanced or not), but guard anyway.
  const sigma2PromptRaw = n0 > 0 ? (msB - msW) / n0 : 0;
  const sigma2Prompt = Math.max(0, sigma2PromptRaw);

  const totalVar = sigma2Prompt + sigma2Resid;
  const icc = totalVar > 0 ? sigma2Prompt / totalVar : null;

  const clampNote = sigma2PromptRaw < 0 ? " (between-prompt MoM estimate was negative → clamped to 0: no detectable prompt-level variance)" : "";
  return {
    sigma2Prompt,
    sigma2Resid,
    icc,
    nPrompts: P,
    nTotal: N,
    n0,
    grandMean,
    estimable: true,
    note: `Linear-probability variance decomposition (binary outcome, ANOVA approximation for budgeting; not a logistic decomposition).${clampNote}`,
  };
}

// ---------------------------------------------------------------------------
// D-study
// ---------------------------------------------------------------------------

/**
 * Standard error of the overall mean visibility under a BALANCED design of
 * `nPrompts` prompts × `nRunsPerPrompt` runs each:
 *
 *   Var(θ̂) = σ²_prompt / P' + σ²_resid / (P' · n')
 *
 * Returns Infinity for P' ≤ 0 or n' ≤ 0. PURE.
 */
export function predictMeanSe(
  vc: Pick<VarianceComponents, "sigma2Prompt" | "sigma2Resid">,
  nPrompts: number,
  nRunsPerPrompt: number,
): number {
  if (nPrompts <= 0 || nRunsPerPrompt <= 0) return Infinity;
  const v = vc.sigma2Prompt / nPrompts + vc.sigma2Resid / (nPrompts * nRunsPerPrompt);
  return Math.sqrt(Math.max(0, v));
}

export interface DStudy {
  /**
   * Projected SE of the mean under a BALANCED design at the current (P, n) —
   * NOT the realized SE of the unbalanced fit (the DStudy interface takes scalar
   * P and n, so it can only express a balanced projection; for unequal n_p the
   * realized SE is σ²_prompt·Σn_p²/N² + σ²_resid/N). Infinity when not estimable. (v8 Z3)
   */
  currentSe: number;
  targetSe: number;
  /** True when currentSe ≤ targetSe. Replaces the binary lowPower flag. */
  samplingAdequate: boolean;
  /**
   * Holding the number of prompts fixed, the minimum runs-PER-PROMPT to reach
   * targetSe. null when UNREACHABLE by adding runs — i.e. the between-prompt term
   * σ²_prompt/P alone already exceeds targetSe² (you must add prompts, not runs).
   */
  recommendedRunsPerPrompt: number | null;
  /**
   * Holding runs-per-prompt fixed, the minimum number of PROMPTS to reach targetSe.
   * Always reachable (the mean SE → 0 as P → ∞).
   */
  recommendedPrompts: number | null;
}

/**
 * Run a D-study: given estimated components and the current design, report
 * whether the current SE meets targetSe and how to reach it by adding runs or
 * prompts. PURE. Throws RangeError on targetSe ≤ 0.
 */
export function dStudy(
  vc: VarianceComponents,
  opts: { targetSe: number; nPromptsCurrent: number; nRunsPerPromptCurrent: number },
): DStudy {
  const { targetSe, nPromptsCurrent, nRunsPerPromptCurrent } = opts;
  if (!(targetSe > 0)) throw new RangeError(`targetSe must be > 0, got ${targetSe}`);

  // v8 Z1: a non-estimable design returns σ²=0 placeholders (estimable=false).
  // Without this guard predictMeanSe would return 0 → samplingAdequate=true,
  // CERTIFYING a degenerate design (P<2 or no repeated runs) as a perfect SE=0
  // estimate. Honesty: an unidentifiable variance is unknowable, never adequate.
  if (!vc.estimable) {
    return {
      currentSe: Infinity,
      targetSe,
      samplingAdequate: false,
      recommendedRunsPerPrompt: null,
      recommendedPrompts: null,
    };
  }

  // v10 Z1: a CONSTANT binary outcome (every observation 0, or every 1 — e.g. a
  // brand NEVER mentioned, the common "SMR 0%" baseline) is estimable (P≥2,
  // residual df>0) yet has σ²_prompt=σ²_resid=0, so predictMeanSe returns 0 and
  // the design would be falsely certified as a perfect zero-SE estimate. A
  // zero-variance sample does NOT make the true rate certain — the SE is not
  // identifiable from a degenerate sample. Refuse it honestly (same boundary/
  // degeneracy discipline as the Wald-variance fixes in judgeDebias/driftControl).
  if (!(vc.sigma2Prompt + vc.sigma2Resid > 0)) {
    return {
      currentSe: Infinity,
      targetSe,
      samplingAdequate: false,
      recommendedRunsPerPrompt: null,
      recommendedPrompts: null,
    };
  }

  const currentSe = predictMeanSe(vc, nPromptsCurrent, nRunsPerPromptCurrent);
  const target2 = targetSe * targetSe;

  // Runs needed holding P fixed:  σ²_prompt/P + σ²_resid/(P·n') ≤ target²
  //   ⇒ n' ≥ σ²_resid / (P·target² − σ²_prompt)   (null when denom ≤ 0)
  let recommendedRunsPerPrompt: number | null = null;
  if (nPromptsCurrent > 0) {
    const denom = nPromptsCurrent * target2 - vc.sigma2Prompt;
    if (denom > 0) {
      const nPrime = vc.sigma2Resid / denom;
      recommendedRunsPerPrompt = Math.max(1, Math.ceil(nPrime));
    } else {
      recommendedRunsPerPrompt = null; // between-prompt variance alone exceeds target
    }
  }

  // Prompts needed holding n fixed:  (σ²_prompt + σ²_resid/n)/P' ≤ target²
  //   ⇒ P' ≥ (σ²_prompt + σ²_resid/n) / target²
  let recommendedPrompts: number | null = null;
  if (nRunsPerPromptCurrent > 0) {
    const numer = vc.sigma2Prompt + vc.sigma2Resid / nRunsPerPromptCurrent;
    recommendedPrompts = Math.max(1, Math.ceil(numer / target2));
  }

  return {
    currentSe,
    targetSe,
    samplingAdequate: currentSe <= targetSe,
    recommendedRunsPerPrompt,
    recommendedPrompts,
  };
}
