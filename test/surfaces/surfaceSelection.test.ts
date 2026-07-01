/**
 * test/surfaces/surfaceSelection.test.ts
 *
 * T17 — Surface selection: not-configured + scrape-on-baseline exclusion.
 *
 * DESIGN-phase4.md T12 / SPEC.md §4 (surfaces/tiers), §5 (measurement).
 *
 * Invariants under test:
 *   1. NOT_CONFIGURED adapters are always excluded (status !== 'ready').
 *   2. Stub adapters are always excluded (status === 'stub').
 *   3. Scrape surfaces are excluded from BASELINE runs.
 *   4. Scrape surfaces ARE included in OPERATING runs when ready.
 *   5. Ready SERP surfaces are included in BASELINE runs (official API path).
 *   6. Ready chat surfaces pass through unchanged (not filtered here).
 *   7. selectEligibleSurfaceAdapters pre-filters to non-chat adapters.
 *   8. droppedCount and droppedReasons are accurate.
 *   9. Empty adapter list returns empty eligible with zero dropped.
 */

import { describe, it, expect } from "vitest";
import {
  selectEligibleSurfaces,
  selectEligibleSurfaceAdapters,
} from "../../src/surfaces/surfaceSelection.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import { NOT_CONFIGURED } from "../../src/providers/types.js";
import type { Modality, SurfaceCapability } from "../../src/domain/types.js";

// ---------------------------------------------------------------------------
// Test double: minimal ProviderAdapter implementation
// ---------------------------------------------------------------------------

function makeAdapter(overrides: {
  provider: string;
  modality: Modality;
  status: "ready" | "stub" | "not_configured";
  capabilities?: SurfaceCapability[];
}): ProviderAdapter {
  return {
    provider: overrides.provider,
    modality: overrides.modality,
    capabilities: overrides.capabilities ?? ["generate"],
    status: overrides.status,
    async generate() {
      return { ok: false, code: NOT_CONFIGURED };
    },
    async judge() {
      return { ok: false, code: NOT_CONFIGURED };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ready SERP adapter (e.g. googleAio when SERP_API_KEY is set). */
const readySerpAdapter = makeAdapter({ provider: "googleAio", modality: "serp", status: "ready" });

/** A ready scrape adapter (e.g. copilot when RPA_RUNNER_URL is set). */
const readyScrapeAdapter = makeAdapter({ provider: "copilot", modality: "scrape", status: "ready" });

/** A not-configured SERP adapter (no SERP_API_KEY). */
const notConfiguredSerpAdapter = makeAdapter({ provider: "naverAi", modality: "serp", status: "not_configured" });

/** A not-configured scrape adapter (no RPA_RUNNER_URL). */
const notConfiguredScrapeAdapter = makeAdapter({ provider: "metaAi", modality: "scrape", status: "not_configured" });

/** A stub adapter (unimplemented provider). */
const stubChatAdapter = makeAdapter({ provider: "openai", modality: "chat", status: "stub" });

/** A ready chat adapter (existing Phase 0 adapter, e.g. Gemini). */
const readyChatAdapter = makeAdapter({ provider: "gemini", modality: "chat", status: "ready" });

/** Another not-configured scrape adapter. */
const notConfiguredScrape2 = makeAdapter({ provider: "line", modality: "scrape", status: "not_configured" });

// ---------------------------------------------------------------------------
// 1. NOT_CONFIGURED adapters are excluded
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — not_configured excluded", () => {
  it("excludes a not_configured SERP adapter from baseline", () => {
    const result = selectEligibleSurfaces({
      adapters: [notConfiguredSerpAdapter],
      runKind: "baseline",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedReasons.notReady).toBe(1);
    expect(result.droppedReasons.scrapeOnBaseline).toBe(0);
  });

  it("excludes a not_configured scrape adapter from operating", () => {
    const result = selectEligibleSurfaces({
      adapters: [notConfiguredScrapeAdapter],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedReasons.notReady).toBe(1);
  });

  it("excludes multiple not_configured adapters", () => {
    const result = selectEligibleSurfaces({
      adapters: [notConfiguredSerpAdapter, notConfiguredScrapeAdapter, notConfiguredScrape2],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedReasons.notReady).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Stub adapters are excluded
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — stub excluded", () => {
  it("excludes a stub chat adapter", () => {
    const result = selectEligibleSurfaces({
      adapters: [stubChatAdapter],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedReasons.notReady).toBe(1);
  });

  it("excludes stub + not_configured together", () => {
    const result = selectEligibleSurfaces({
      adapters: [stubChatAdapter, notConfiguredSerpAdapter],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedReasons.notReady).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Scrape surfaces excluded from BASELINE
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — scrape excluded on baseline", () => {
  it("excludes a ready scrape adapter from baseline run", () => {
    const result = selectEligibleSurfaces({
      adapters: [readyScrapeAdapter],
      runKind: "baseline",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedReasons.scrapeOnBaseline).toBe(1);
    expect(result.droppedReasons.notReady).toBe(0);
  });

  it("excludes all ready scrape adapters from baseline", () => {
    const readyScrape2 = makeAdapter({ provider: "line", modality: "scrape", status: "ready" });
    const result = selectEligibleSurfaces({
      adapters: [readyScrapeAdapter, readyScrape2],
      runKind: "baseline",
    });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedReasons.scrapeOnBaseline).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Scrape surfaces included in OPERATING
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — scrape included on operating", () => {
  it("includes a ready scrape adapter in operating run", () => {
    const result = selectEligibleSurfaces({
      adapters: [readyScrapeAdapter],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]).toBe(readyScrapeAdapter);
    expect(result.droppedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Ready SERP surfaces included in BASELINE
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — ready SERP included on baseline", () => {
  it("includes a ready SERP adapter in baseline run", () => {
    const result = selectEligibleSurfaces({
      adapters: [readySerpAdapter],
      runKind: "baseline",
    });
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]).toBe(readySerpAdapter);
    expect(result.droppedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Ready chat adapters pass through unchanged
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — chat adapters pass through", () => {
  it("includes a ready chat adapter in baseline", () => {
    const result = selectEligibleSurfaces({
      adapters: [readyChatAdapter],
      runKind: "baseline",
    });
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]).toBe(readyChatAdapter);
  });

  it("includes a ready chat adapter in operating", () => {
    const result = selectEligibleSurfaces({
      adapters: [readyChatAdapter],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. selectEligibleSurfaceAdapters pre-filters to non-chat
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaceAdapters — surfaces-only variant", () => {
  it("excludes ready chat adapters from the result", () => {
    const result = selectEligibleSurfaceAdapters({
      adapters: [readyChatAdapter, readySerpAdapter],
      runKind: "baseline",
    });
    // readyChatAdapter is filtered out (chat modality), readySerpAdapter passes
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]).toBe(readySerpAdapter);
  });

  it("excludes not-configured surface adapters", () => {
    const result = selectEligibleSurfaceAdapters({
      adapters: [readyChatAdapter, notConfiguredSerpAdapter],
      runKind: "baseline",
    });
    // Chat adapter excluded (not a surface); notConfigured excluded (not ready)
    expect(result.eligible).toHaveLength(0);
  });

  it("on operating: returns only ready scrape/serp surfaces", () => {
    const result = selectEligibleSurfaceAdapters({
      adapters: [readyChatAdapter, readySerpAdapter, readyScrapeAdapter],
      runKind: "operating",
    });
    expect(result.eligible).toHaveLength(2);
    expect(result.eligible).toContain(readySerpAdapter);
    expect(result.eligible).toContain(readyScrapeAdapter);
    expect(result.eligible).not.toContain(readyChatAdapter);
  });
});

// ---------------------------------------------------------------------------
// 8. Mixed scenario: accurate droppedCount + droppedReasons
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — mixed scenario, accurate diagnostics", () => {
  it("correctly counts drops in a mixed adapter list", () => {
    // On baseline:
    //   readySerpAdapter     → eligible (SERP, ready)
    //   readyChatAdapter     → eligible (chat, ready)
    //   notConfiguredSerp    → dropped (notReady)
    //   readyScrapeAdapter   → dropped (scrapeOnBaseline)
    //   stubChatAdapter      → dropped (notReady)
    const result = selectEligibleSurfaces({
      adapters: [
        readySerpAdapter,
        readyChatAdapter,
        notConfiguredSerpAdapter,
        readyScrapeAdapter,
        stubChatAdapter,
      ],
      runKind: "baseline",
    });

    expect(result.eligible).toHaveLength(2);
    expect(result.eligible).toContain(readySerpAdapter);
    expect(result.eligible).toContain(readyChatAdapter);

    expect(result.droppedCount).toBe(3);
    expect(result.droppedReasons.notReady).toBe(2);      // notConfigured + stub
    expect(result.droppedReasons.scrapeOnBaseline).toBe(1); // readyScrape
  });

  it("on operating: all ready adapters included, only not-ready dropped", () => {
    const result = selectEligibleSurfaces({
      adapters: [
        readySerpAdapter,
        readyChatAdapter,
        readyScrapeAdapter,
        notConfiguredSerpAdapter,
      ],
      runKind: "operating",
    });

    expect(result.eligible).toHaveLength(3);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedReasons.notReady).toBe(1);
    expect(result.droppedReasons.scrapeOnBaseline).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Empty adapter list
// ---------------------------------------------------------------------------

describe("selectEligibleSurfaces — empty input", () => {
  it("returns empty eligible with zero dropped for baseline", () => {
    const result = selectEligibleSurfaces({ adapters: [], runKind: "baseline" });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedReasons.notReady).toBe(0);
    expect(result.droppedReasons.scrapeOnBaseline).toBe(0);
  });

  it("returns empty eligible with zero dropped for operating", () => {
    const result = selectEligibleSurfaces({ adapters: [], runKind: "operating" });
    expect(result.eligible).toHaveLength(0);
    expect(result.droppedCount).toBe(0);
  });
});
