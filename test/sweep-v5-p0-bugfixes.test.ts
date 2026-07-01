/**
 * test/sweep-v5-p0-bugfixes.test.ts
 *
 * Regression locks for the SEVEN P0 self-audit bugs found by SOTA sweep v5.
 * Each was verified by an adversarial critic in the actual code and would
 * silently corrupt a headline honesty metric while passing the mocked suites.
 *
 *   X1  grounding chunk index misalignment drops real citations
 *   X2  LIST_HEADERS substring over-fires RECOMMENDATIONs ("best" in "asbestos")
 *   X3  wrapper-title domain extraction injects phantom earned sources ("report.pdf")
 *   X4  k/m/b unit-suffix collision (months scaled as millions)
 *   X5  exact numeric bound blocks at source value 0 (relative tolerance → 0)
 *   X6  curly apostrophe defeats negation suppression ("isn't" → not suppressed)
 *   X8  substring error routing ("rate" inside "generated" → false RATE_LIMITED)
 */

import { describe, it, expect } from "vitest";
import { detectRecommendation } from "../src/judge/recommendation.js";
import { checkNumericBound } from "../src/content/claimVerify.js";
import { computeGroundingGap, domainForChunk } from "../src/judge/groundingGap.js";
import { extractGroundingTrace, classifyGeminiError } from "../src/providers/gemini.js";

// ---------------------------------------------------------------------------
// X2 — LIST_HEADERS must be bounded words, not substrings
// ---------------------------------------------------------------------------
describe("X2 — recommendation LIST_HEADERS bounded matching", () => {
  it("does NOT treat 'best' inside 'asbestos' as a list framing", () => {
    // "asbestos" contains "best"; the brand is merely mentioned, not recommended.
    const text = "Asbestos removal is regulated. EMORA is a chat app unrelated to it.";
    const r = detectRecommendation(text, ["EMORA"]);
    expect(r.present).toBe(false);
  });

  it("still fires on a genuine 'best' list framing", () => {
    const text = "Best AI chat apps:\n1. EMORA — great for character chat\n2. Other";
    const r = detectRecommendation(text, ["EMORA"]);
    expect(r.present).toBe(true);
    expect(r.kind).toBe("list");
  });
});

// ---------------------------------------------------------------------------
// X6 — curly apostrophe must not defeat negation suppression
// ---------------------------------------------------------------------------
describe("X6 — curly-apostrophe negation suppression", () => {
  it("suppresses a recommend-verb when negated with a TYPOGRAPHIC apostrophe", () => {
    // "wouldn't" with U+2019 must still hit NEGATION after normalization so the
    // negation (which precedes the brand) suppresses the recommend-verb. Before
    // the fix, the curly apostrophe defeated NEGATION and this falsely fired.
    const text = "I wouldn’t recommend EMORA for enterprise teams.";
    const r = detectRecommendation(text, ["EMORA"]);
    expect(r.present).toBe(false);
  });

  it("still fires on the same construction WITHOUT negation", () => {
    const text = "I would recommend EMORA for character chat.";
    const r = detectRecommendation(text, ["EMORA"]);
    expect(r.present).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// X5 — exact numeric bound at source value 0
// ---------------------------------------------------------------------------
describe("X5 — exact bound tolerance floor at zero", () => {
  it("0 vs exact 0 is within (not a spurious 'exceeds')", () => {
    expect(checkNumericBound(0, "%", 0, "%", "exact")).toBe("within");
  });
  it("tiny float drift around zero is within", () => {
    expect(checkNumericBound(1e-12, "%", 0, "%", "exact")).toBe("within");
  });
  it("a real non-zero claim against exact 0 still exceeds", () => {
    expect(checkNumericBound(5, "%", 0, "%", "exact")).toBe("exceeds");
  });
});

// ---------------------------------------------------------------------------
// X4 — k/m/b unit-suffix collision
// ---------------------------------------------------------------------------
describe("X4 — ambiguous m/b suffix fails closed", () => {
  it("bare 'm' (months vs million) is incompatible, never magnitude-scaled", () => {
    // Old bug: both scaled to 'count' at 1e6 → "6 m" (months) <= "12 m" within.
    expect(checkNumericBound(6, "m", 12, "m", "upTo")).toBe("incompatible");
  });
  it("bare 'b' is incompatible (ambiguous)", () => {
    expect(checkNumericBound(2, "b", 3, "b", "upTo")).toBe("incompatible");
  });
  it("explicit 'million' still scales and compares", () => {
    expect(checkNumericBound(2, "million", 3, "million", "upTo")).toBe("within");
  });
  it("'k' (thousand) still scales and compares", () => {
    expect(checkNumericBound(5, "k", 3, "k", "atLeast")).toBe("within");
  });
});

// ---------------------------------------------------------------------------
// X8 — word-boundary error classification
// ---------------------------------------------------------------------------
describe("X8 — Gemini error classifier word boundaries", () => {
  it("'generated' / 'moderate' do NOT route to RATE_LIMITED", () => {
    expect(classifyGeminiError(new Error("content was not generated"))).toBe("PROVIDER_ERROR");
    expect(classifyGeminiError(new Error("response flagged as moderate risk"))).toBe("PROVIDER_ERROR");
  });
  it("genuine rate-limit phrasing routes to RATE_LIMITED", () => {
    expect(classifyGeminiError(new Error("429 Too Many Requests"))).toBe("RATE_LIMITED");
    expect(classifyGeminiError(new Error("rate limit exceeded"))).toBe("RATE_LIMITED");
    expect(classifyGeminiError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe("RATE_LIMITED");
  });
  it("merely naming the api key does NOT route to NOT_CONFIGURED", () => {
    expect(classifyGeminiError(new Error("the api key was used for this generated call"))).toBe("PROVIDER_ERROR");
  });
  it("genuine auth failure routes to NOT_CONFIGURED", () => {
    expect(classifyGeminiError(new Error("API key not valid. Please pass a valid API key."))).toBe("NOT_CONFIGURED");
    expect(classifyGeminiError(new Error("403 Permission denied"))).toBe("NOT_CONFIGURED");
  });
  it("timeout routes to TIMEOUT", () => {
    expect(classifyGeminiError(new Error("deadline exceeded"))).toBe("TIMEOUT");
  });
});

// ---------------------------------------------------------------------------
// X1 — grounding chunk index alignment
// ---------------------------------------------------------------------------
describe("X1 — grounding chunk index alignment preserved", () => {
  it("keeps a cited domain whose chunk follows a leading empty-uri chunk", () => {
    // chunk[0] has an empty uri; the REAL cited source is chunk[1]. The support
    // references raw index 1. If we filtered chunk[0], index 1 would shift to a
    // missing slot and the citation would vanish.
    const response = {
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: ["best ai chat"],
            groundingChunks: [
              { web: { uri: "", title: "" } },
              { web: { uri: "https://reddit.com/r/x", title: "reddit.com" } },
            ],
            groundingSupports: [{ groundingChunkIndices: [1] }],
          },
        },
      ],
    };
    const trace = extractGroundingTrace(response);
    expect(trace.chunks).toHaveLength(2); // empty-uri chunk retained for alignment
    const gap = computeGroundingGap(trace);
    expect(gap.citedDomains).toContain("reddit.com");
  });
});

// ---------------------------------------------------------------------------
// X3 — phantom domains from wrapper titles
// ---------------------------------------------------------------------------
describe("X3 — wrapper-title domain extraction rejects non-domains", () => {
  const WRAPPER = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
  it("rejects a file name as a phantom domain", () => {
    expect(domainForChunk(WRAPPER, "Q3 report.pdf")).toBeNull();
    expect(domainForChunk(WRAPPER, "architecture diagram.png")).toBeNull();
  });
  it("rejects a version token", () => {
    expect(domainForChunk(WRAPPER, "release v3.2 notes")).toBeNull();
  });
  it("still extracts a real domain from the title", () => {
    expect(domainForChunk(WRAPPER, "Reddit thread — reddit.com")).toBe("reddit.com");
    expect(domainForChunk(WRAPPER, "BBC News bbc.co.uk")).toBe("bbc.co.uk");
  });
});
