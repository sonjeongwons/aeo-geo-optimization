/**
 * src/metrics/earnedSources.ts — the earned-source corpus (v2-critic gap #1, the
 * "biggest miss"; unblocked by the v3 grounding capture).
 *
 * Every other metric measures the BRAND's own presence. This aggregates the FULL
 * set of THIRD-PARTY domains the answer engines actually CITE across the prompt
 * corpus into a "who gets cited for our prompts" frequency graph — the highest-
 * leverage off-site TARGETING input the engine otherwise discards (which Reddit
 * threads / listicles / wikis / review sites to earn a placement on).
 *
 * Input is the engine's OWN returned grounding/citation data (domains the model
 * fetched + cited). §0: it NEVER fetches any URL — it reads engine-returned URLs
 * only. §7: every rate carries a Wilson CI + lowPower; co-citation is reported as
 * a count + CI, never a bare percentage.
 *
 * PURE — no IO, no pg. The DB-backed wrapper (aggregate.ts) feeds it per-response
 * grounding traces read from response_raw.provider_meta.
 */

import { wilsonInterval } from "../domain/metrics.types.js";

/** One response's earned-source signal (from its grounding trace / citations). */
export interface ResponseSourceSignal {
  /** Registrable domains the engine CITED in this response (deduped). */
  citedDomains: string[];
  /** Registrable domains the engine FETCHED (deduped). Superset of cited. */
  fetchedDomains: string[];
  /** True when the tracked brand was mentioned in this response. */
  brandMentioned: boolean;
  modelId: string;
}

export interface EarnedSourceDomain {
  domain: string;
  /** # responses that CITED this domain. */
  citedResponses: number;
  /** # responses that FETCHED this domain (cited ⊆ fetched). */
  fetchedResponses: number;
  /** # responses where this domain was cited AND the brand was mentioned. */
  brandCoCitedResponses: number;
  /** citedResponses / nResponses, with Wilson CI. */
  citationRate: number;
  ci95: { lower: number; upper: number };
  lowPower: boolean; // nResponses < 100
  /** P(cited | fetched) for this domain — how often a fetch survives to a citation. */
  citedWhenFetchedRate: number;
}

export interface EarnedSourceCorpus {
  /** # responses that carried any grounding/citation signal (the denominator). */
  nResponses: number;
  /** Domains ranked by citedResponses desc (the targeting list). */
  domains: EarnedSourceDomain[];
}

/**
 * Aggregate per-response source signals into the earned-source corpus.
 * PURE. Domains are ranked by citation frequency (the targeting priority).
 *
 * @param signals  one entry per response that had grounding/citation data
 * @param brandDomains  registrable domains belonging to the brand, to EXCLUDE
 *   from the earned (third-party) list (defaults to none; the engine has no
 *   customer domain in state per §0, but a caller may pass known owned-net hosts).
 */
export function aggregateEarnedSources(
  signals: ResponseSourceSignal[],
  brandDomains: string[] = [],
): EarnedSourceCorpus {
  const owned = new Set(brandDomains.map((d) => d.toLowerCase()));
  const n = signals.length;

  const cited = new Map<string, number>();
  const fetched = new Map<string, number>();
  const coCited = new Map<string, number>();

  for (const s of signals) {
    const citedSet = new Set(s.citedDomains.map((d) => d.toLowerCase()).filter((d) => !owned.has(d)));
    const fetchedSet = new Set(s.fetchedDomains.map((d) => d.toLowerCase()).filter((d) => !owned.has(d)));
    for (const d of fetchedSet) fetched.set(d, (fetched.get(d) ?? 0) + 1);
    for (const d of citedSet) {
      cited.set(d, (cited.get(d) ?? 0) + 1);
      if (s.brandMentioned) coCited.set(d, (coCited.get(d) ?? 0) + 1);
    }
  }

  const domains: EarnedSourceDomain[] = Array.from(
    new Set([...cited.keys(), ...fetched.keys()]),
  ).map((domain) => {
    const c = cited.get(domain) ?? 0;
    const f = fetched.get(domain) ?? 0;
    return {
      domain,
      citedResponses: c,
      fetchedResponses: f,
      brandCoCitedResponses: coCited.get(domain) ?? 0,
      citationRate: n > 0 ? c / n : 0,
      ci95: wilsonInterval(c, n),
      lowPower: n < 100,
      citedWhenFetchedRate: f > 0 ? c / f : 0,
    };
  });

  // Rank by citation frequency (then fetched, then domain for stability).
  domains.sort(
    (a, b) =>
      b.citedResponses - a.citedResponses ||
      b.fetchedResponses - a.fetchedResponses ||
      a.domain.localeCompare(b.domain),
  );

  return { nResponses: n, domains };
}
