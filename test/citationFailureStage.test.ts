/**
 * test/citationFailureStage.test.ts — unit tests for the citation-failure-stage
 * classifier (Feature X18).
 *
 * Covers every branch of the truth table documented in
 * src/judge/citationFailureStage.ts, plus aggregate histogram correctness and
 * determinism.
 */
import { describe, it, expect } from "vitest";
import {
  classifyCitationFailureStage,
  aggregateFailureStages,
  type FailureStageInput,
  type CitationFailureStage,
} from "../src/judge/citationFailureStage.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const TARGET = "emora.ai";
const FETCHED = [TARGET, "reddit.com", "g2.com"];
const CITED = [TARGET, "reddit.com"];

function base(overrides: Partial<FailureStageInput> = {}): FailureStageInput {
  return {
    targetDomain: TARGET,
    fetchedDomains: FETCHED,
    citedDomains: CITED,
    brandMentioned: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. not fetched + brand NOT mentioned → "retrieval"
// ---------------------------------------------------------------------------

describe('stage: "retrieval"', () => {
  it("returns retrieval when target is not fetched and brand not mentioned", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: ["reddit.com", "g2.com"],
      citedDomains: ["reddit.com"],
      brandMentioned: false,
    });
    expect(result).toBe("retrieval");
  });

  it("returns retrieval when both fetchedDomains and citedDomains are empty", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: [],
      citedDomains: [],
      brandMentioned: false,
    });
    expect(result).toBe("retrieval");
  });

  it("ignores absorptionWeight when target was never fetched and brand not mentioned", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: [],
      citedDomains: [],
      brandMentioned: false,
      absorptionWeight: 0.9,
    });
    expect(result).toBe("retrieval");
  });
});

// ---------------------------------------------------------------------------
// 2. not fetched + brand mentioned → "attribution"
// ---------------------------------------------------------------------------

describe('stage: "attribution"', () => {
  it("returns attribution when target not fetched but brand IS mentioned", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: ["reddit.com"],
      citedDomains: ["reddit.com"],
      brandMentioned: true,
    });
    expect(result).toBe("attribution");
  });

  it("returns attribution when nothing fetched at all but brand mentioned", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: [],
      citedDomains: [],
      brandMentioned: true,
    });
    expect(result).toBe("attribution");
  });
});

// ---------------------------------------------------------------------------
// 3. fetched but NOT cited → "reranking"
// ---------------------------------------------------------------------------

describe('stage: "reranking"', () => {
  it("returns reranking when target fetched but not cited", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: [TARGET, "reddit.com"],
      citedDomains: ["reddit.com"],
      brandMentioned: false,
    });
    expect(result).toBe("reranking");
  });

  it("returns reranking even when brand is mentioned (reranking takes precedence over attribution once fetched)", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: [TARGET, "reddit.com"],
      citedDomains: ["reddit.com"],
      brandMentioned: true,
    });
    expect(result).toBe("reranking");
  });

  it("returns reranking regardless of absorptionWeight when not cited", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: [TARGET],
      citedDomains: [],
      brandMentioned: false,
      absorptionWeight: 0.0,
    });
    expect(result).toBe("reranking");
  });
});

// ---------------------------------------------------------------------------
// 4. cited + absorptionWeight ≤ threshold → "extraction"
// ---------------------------------------------------------------------------

describe('stage: "extraction"', () => {
  it("returns extraction when cited and absorptionWeight equals the default threshold (0.05)", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 0.05 }));
    expect(result).toBe("extraction");
  });

  it("returns extraction when cited and absorptionWeight is below the default threshold", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 0.01 }));
    expect(result).toBe("extraction");
  });

  it("returns extraction when cited and absorptionWeight is exactly zero", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 0.0 }));
    expect(result).toBe("extraction");
  });

  it("respects a custom extractionThreshold option", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 0.15 }), {
      extractionThreshold: 0.2,
    });
    expect(result).toBe("extraction");
  });
});

// ---------------------------------------------------------------------------
// 5. cited + absorptionWeight > threshold → "none"
// ---------------------------------------------------------------------------

describe('stage: "none" — cited with high absorption', () => {
  it("returns none when cited and absorptionWeight is above the default threshold", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 0.5 }));
    expect(result).toBe("none");
  });

  it("returns none when cited and absorptionWeight is just above the threshold (0.051)", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 0.051 }));
    expect(result).toBe("none");
  });

  it("returns none when cited and absorptionWeight is 1.0", () => {
    const result = classifyCitationFailureStage(base({ absorptionWeight: 1.0 }));
    expect(result).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 6. cited + absorptionWeight undefined → "none" (cannot assert extraction)
// ---------------------------------------------------------------------------

describe('stage: "none" — cited with absent absorptionWeight', () => {
  it("returns none when cited and absorptionWeight is not provided", () => {
    const result = classifyCitationFailureStage(base());
    // base() has no absorptionWeight property set
    expect(result).toBe("none");
  });

  it("returns none when cited even if brand was NOT mentioned and weight absent", () => {
    const result = classifyCitationFailureStage(base({ brandMentioned: false }));
    expect(result).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 7. "unknown" — data-integrity anomaly (cited but not in fetched)
// ---------------------------------------------------------------------------

describe('stage: "unknown" — integrity anomaly', () => {
  it("returns unknown when target is in citedDomains but not in fetchedDomains", () => {
    const result = classifyCitationFailureStage({
      targetDomain: TARGET,
      fetchedDomains: ["reddit.com"],
      citedDomains: [TARGET, "reddit.com"],
      brandMentioned: false,
    });
    expect(result).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 8. aggregateFailureStages — histogram counts and total
// ---------------------------------------------------------------------------

describe("aggregateFailureStages", () => {
  it("counts each stage and sets total to stages.length", () => {
    const stages: CitationFailureStage[] = [
      "retrieval",
      "retrieval",
      "reranking",
      "extraction",
      "attribution",
      "none",
      "none",
      "unknown",
    ];
    const hist = aggregateFailureStages(stages);
    expect(hist.retrieval).toBe(2);
    expect(hist.reranking).toBe(1);
    expect(hist.extraction).toBe(1);
    expect(hist.attribution).toBe(1);
    expect(hist.none).toBe(2);
    expect(hist.unknown).toBe(1);
    expect(hist.total).toBe(8);
  });

  it("returns all-zero histogram (except total=0) for empty input", () => {
    const hist = aggregateFailureStages([]);
    expect(hist.retrieval).toBe(0);
    expect(hist.reranking).toBe(0);
    expect(hist.extraction).toBe(0);
    expect(hist.attribution).toBe(0);
    expect(hist.none).toBe(0);
    expect(hist.unknown).toBe(0);
    expect(hist.total).toBe(0);
  });

  it("sums all stages to equal total", () => {
    const stages: CitationFailureStage[] = ["none", "none", "retrieval", "reranking", "attribution"];
    const hist = aggregateFailureStages(stages);
    const sum =
      hist.retrieval + hist.reranking + hist.extraction +
      hist.attribution + hist.none + hist.unknown;
    expect(sum).toBe(hist.total);
  });
});

// ---------------------------------------------------------------------------
// 9. Determinism — same input always yields same output
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces identical results across 100 repeated calls with the same input", () => {
    const input: FailureStageInput = base({ absorptionWeight: 0.03 });
    const first = classifyCitationFailureStage(input);
    for (let i = 0; i < 99; i++) {
      expect(classifyCitationFailureStage(input)).toBe(first);
    }
  });

  it("produces stable aggregate histograms for the same stage array", () => {
    const stages: CitationFailureStage[] = ["retrieval", "none", "reranking", "attribution", "extraction"];
    const h1 = aggregateFailureStages(stages);
    const h2 = aggregateFailureStages(stages);
    expect(h1).toEqual(h2);
  });
});
