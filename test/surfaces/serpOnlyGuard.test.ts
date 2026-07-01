/**
 * test/surfaces/serpOnlyGuard.test.ts
 *
 * T17 — Guard: Google AI Overviews + Naver AI are OFFICIAL-SERP-API-ONLY
 * and MUST NOT be constructible via the RPA/scrape runner.
 *
 * DESIGN-phase4.md §12 / SPEC.md §12 (compliance).
 *
 * Tests:
 *   1. assertSerpOnly passes for googleAio and naverAi (confirmed SERP-only).
 *   2. assertSerpOnly throws for scrape surfaces (copilot, metaAi, line, kakao).
 *   3. assertNotSerpOnly passes for all scrape surfaces.
 *   4. assertNotSerpOnly throws for googleAio and naverAi.
 *   5. SERP_ONLY_SURFACES set contains exactly the two compliance-required surfaces.
 *   6. SCRAPE_SURFACES set contains exactly the four scrape surfaces.
 *   7. The sets are disjoint (no overlap).
 *   8. makeGoogleAioAdapter only accepts SerpClient (type-level guard verified at module-load).
 *   9. makeNaverAiAdapter only accepts SerpClient (type-level guard verified at module-load).
 *  10. COMPLIANCE_MANIFEST entries are fully populated for every v1-b surface.
 */

import { describe, it, expect } from "vitest";
import {
  assertSerpOnly,
  assertNotSerpOnly,
  SERP_ONLY_SURFACES,
  SCRAPE_SURFACES,
  COMPLIANCE_MANIFEST,
  isScrapePermitted,
  requiresNativeReview,
  getComplianceEntry,
} from "../../src/surfaces/compliance.js";
import type { SurfaceId } from "../../src/surfaces/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const SERP_IDS: SurfaceId[] = ["googleAio", "googleAiMode", "naverAi"];
const SCRAPE_IDS: SurfaceId[] = ["copilot", "metaAi", "line", "kakao"];
const ALL_SURFACE_IDS: SurfaceId[] = [...SERP_IDS, ...SCRAPE_IDS];

// ---------------------------------------------------------------------------
// 1. assertSerpOnly — passes for SERP-only surfaces
// ---------------------------------------------------------------------------

describe("assertSerpOnly — passes for SERP-only surfaces", () => {
  for (const id of SERP_IDS) {
    it(`assertSerpOnly("${id}") does NOT throw`, () => {
      expect(() => assertSerpOnly(id)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// 2. assertSerpOnly — throws for scrape surfaces
// ---------------------------------------------------------------------------

describe("assertSerpOnly — throws for scrape surfaces", () => {
  for (const id of SCRAPE_IDS) {
    it(`assertSerpOnly("${id}") throws TypeError`, () => {
      expect(() => assertSerpOnly(id)).toThrow(TypeError);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. assertNotSerpOnly — passes for all scrape surfaces
// ---------------------------------------------------------------------------

describe("assertNotSerpOnly — passes for scrape surfaces", () => {
  for (const id of SCRAPE_IDS) {
    it(`assertNotSerpOnly("${id}") does NOT throw`, () => {
      expect(() => assertNotSerpOnly(id)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// 4. assertNotSerpOnly — throws for SERP-only surfaces
// ---------------------------------------------------------------------------

describe("assertNotSerpOnly — throws for SERP-only surfaces", () => {
  for (const id of SERP_IDS) {
    it(`assertNotSerpOnly("${id}") throws TypeError`, () => {
      expect(() => assertNotSerpOnly(id)).toThrow(TypeError);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. SERP_ONLY_SURFACES contains exactly googleAio and naverAi
// ---------------------------------------------------------------------------

describe("SERP_ONLY_SURFACES set membership", () => {
  it("contains googleAio", () => {
    expect(SERP_ONLY_SURFACES.has("googleAio")).toBe(true);
  });

  it("contains naverAi", () => {
    expect(SERP_ONLY_SURFACES.has("naverAi")).toBe(true);
  });

  it("contains googleAiMode (W2)", () => {
    expect(SERP_ONLY_SURFACES.has("googleAiMode")).toBe(true);
  });

  it("has exactly 3 members", () => {
    expect(SERP_ONLY_SURFACES.size).toBe(3);
  });

  it("does NOT contain any scrape surface", () => {
    for (const id of SCRAPE_IDS) {
      expect(SERP_ONLY_SURFACES.has(id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. SCRAPE_SURFACES contains exactly the four scrape surfaces
// ---------------------------------------------------------------------------

describe("SCRAPE_SURFACES set membership", () => {
  it("contains copilot", () => {
    expect(SCRAPE_SURFACES.has("copilot")).toBe(true);
  });

  it("contains metaAi", () => {
    expect(SCRAPE_SURFACES.has("metaAi")).toBe(true);
  });

  it("contains line", () => {
    expect(SCRAPE_SURFACES.has("line")).toBe(true);
  });

  it("contains kakao", () => {
    expect(SCRAPE_SURFACES.has("kakao")).toBe(true);
  });

  it("has exactly 4 members", () => {
    expect(SCRAPE_SURFACES.size).toBe(4);
  });

  it("does NOT contain any SERP-only surface", () => {
    for (const id of SERP_IDS) {
      expect(SCRAPE_SURFACES.has(id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. SERP_ONLY_SURFACES and SCRAPE_SURFACES are disjoint
// ---------------------------------------------------------------------------

describe("SERP_ONLY_SURFACES and SCRAPE_SURFACES are disjoint", () => {
  it("no surface belongs to both sets", () => {
    for (const id of ALL_SURFACE_IDS) {
      const inSerp = SERP_ONLY_SURFACES.has(id);
      const inScrape = SCRAPE_SURFACES.has(id);
      expect(inSerp && inScrape).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 8-9. Adapter constructors enforce compliance guard at module-load time.
//      Importing these modules (which call assertSerpOnly at module level)
//      should NOT throw — the guard is satisfied for googleAio / naverAi.
// ---------------------------------------------------------------------------

describe("googleAio adapter module loads without throwing (guard satisfied)", () => {
  it("imports makeGoogleAioAdapter without error", async () => {
    await expect(
      import("../../src/surfaces/serp/adapters/googleAio.js")
    ).resolves.toBeDefined();
  });
});

describe("naverAi adapter module loads without throwing (guard satisfied)", () => {
  it("imports makeNaverAiAdapter without error", async () => {
    await expect(
      import("../../src/surfaces/serp/adapters/naverAi.js")
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. COMPLIANCE_MANIFEST — every v1-b surface has a fully populated entry
// ---------------------------------------------------------------------------

describe("COMPLIANCE_MANIFEST — all surfaces registered", () => {
  it("has an entry for every v1-b surface", () => {
    for (const id of ALL_SURFACE_IDS) {
      expect(COMPLIANCE_MANIFEST.has(id)).toBe(true);
    }
  });

  it("SERP-only surfaces have scrapePermitted=false", () => {
    for (const id of SERP_IDS) {
      const entry = getComplianceEntry(id);
      expect(entry.scrapePermitted).toBe(false);
      expect(entry.accessMethod).toBe("official_serp");
    }
  });

  it("scrape surfaces have scrapePermitted=true", () => {
    for (const id of SCRAPE_IDS) {
      const entry = getComplianceEntry(id);
      expect(entry.scrapePermitted).toBe(true);
      expect(entry.accessMethod).toBe("scrape");
    }
  });

  it("isScrapePermitted returns correct values", () => {
    for (const id of SERP_IDS) {
      expect(isScrapePermitted(id)).toBe(false);
    }
    for (const id of SCRAPE_IDS) {
      expect(isScrapePermitted(id)).toBe(true);
    }
  });

  it("nativeReview surfaces are naverAi, line, kakao", () => {
    expect(requiresNativeReview("naverAi")).toBe(true);
    expect(requiresNativeReview("line")).toBe(true);
    expect(requiresNativeReview("kakao")).toBe(true);
    // Copilot and Meta AI are global English-first surfaces — no native review.
    expect(requiresNativeReview("copilot")).toBe(false);
    expect(requiresNativeReview("metaAi")).toBe(false);
    // Google AIO is a global surface — no native review required.
    expect(requiresNativeReview("googleAio")).toBe(false);
  });

  it("every entry has non-empty markets and complianceNotes", () => {
    for (const id of ALL_SURFACE_IDS) {
      const entry = getComplianceEntry(id);
      expect(entry.markets.length).toBeGreaterThan(0);
      expect(entry.complianceNotes.length).toBeGreaterThan(0);
    }
  });
});
