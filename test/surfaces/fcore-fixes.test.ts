/**
 * test/surfaces/fcore-fixes.test.ts
 *
 * F-core cluster defect fixes — regression tests.
 *
 * Covers:
 *   PM-01 — GenerateRequest.language threaded to SurfaceAdapter
 *   CS-01 — SurfaceAdapter constructor throws for §12 violations (structural guard)
 *
 * No DB, no network, no pg — all seams injected as fixtures.
 */

import { describe, it, expect } from "vitest";
import { SurfaceAdapter } from "../../src/surfaces/SurfaceAdapter.js";
import { FixtureSerpClient } from "../../src/surfaces/serp/serpClient.js";
import { FixtureRpaRunner } from "../../src/surfaces/scrape/rpaRunner.js";
import { AiOverviewParser } from "../../src/surfaces/serp/parse/aiOverviewParser.js";
import { CopilotParser } from "../../src/surfaces/scrape/parse/copilotParser.js";
import type { SurfaceId } from "../../src/surfaces/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AIO_RAW = {
  ai_overview: {
    text_blocks: [
      { type: "paragraph", text: "TestBrand is the leading enterprise solution provider." },
    ],
    references: [{ link: "https://testbrand.com", title: "TestBrand" }],
  },
};

const COPILOT_RAW = {
  answerBlock: "TestBrand leads the market in enterprise software.",
  citations: [{ url: "https://testbrand.com", title: "TestBrand", rank: 1 }],
};

// ===========================================================================
// PM-01 — Language threading through GenerateRequest → SurfaceAdapter
// ===========================================================================

describe("PM-01: req.language is used directly by SurfaceAdapter (not promptVersion sentinel)", () => {
  it("SERP adapter passes req.language to buildSerpRequest (not the promptVersion default)", async () => {
    const capturedRequests: Array<{ query: string; language: string }> = [];

    const client = new FixtureSerpClient(AIO_RAW, 0);
    const adapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client,
      parser: new AiOverviewParser(),
      buildSerpRequest: (prompt, lang) => {
        capturedRequests.push({ query: prompt, language: lang });
        return { query: prompt, language: lang };
      },
    });

    await adapter.generate({
      prompt: "best software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
      language: "ko", // <-- explicit language field (PM-01)
    });

    expect(capturedRequests).toHaveLength(1);
    // The language passed to buildSerpRequest must be "ko", not "en" (the default).
    expect(capturedRequests[0]!.language).toBe("ko");
  });

  it("SERP adapter falls back to 'en' when language is absent (backward compat)", async () => {
    const capturedRequests: Array<{ language: string }> = [];

    const client = new FixtureSerpClient(AIO_RAW, 0);
    const adapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client,
      parser: new AiOverviewParser(),
      buildSerpRequest: (prompt, lang) => {
        capturedRequests.push({ language: lang });
        return { query: prompt, language: lang };
      },
    });

    await adapter.generate({
      prompt: "best software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
      // language: NOT provided (omitted)
    });

    expect(capturedRequests[0]!.language).toBe("en");
  });

  it("SERP adapter prefers req.language over promptVersion sentinel when both present", async () => {
    const capturedRequests: Array<{ language: string }> = [];

    const client = new FixtureSerpClient(AIO_RAW, 0);
    const adapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client,
      parser: new AiOverviewParser(),
      buildSerpRequest: (prompt, lang) => {
        capturedRequests.push({ language: lang });
        return { query: prompt, language: lang };
      },
    });

    await adapter.generate({
      prompt: "best software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "lang:ja:v1", // sentinel encodes "ja"
      language: "ko",              // explicit field says "ko" — should WIN
    });

    // req.language takes precedence over promptVersion sentinel (PM-01)
    expect(capturedRequests[0]!.language).toBe("ko");
  });

  it("Scrape adapter passes req.language to buildRpaRequest", async () => {
    const capturedRequests: Array<{ language: string }> = [];

    const runner = new FixtureRpaRunner(COPILOT_RAW, 0);
    const adapter = new SurfaceAdapter({
      kind: "scrape",
      surfaceId: "copilot",
      runner,
      parser: new CopilotParser(),
      buildRpaRequest: (prompt, lang) => {
        capturedRequests.push({ language: lang });
        return {
          targetUrl: "https://copilot.microsoft.com",
          query: prompt,
          language: lang,
        };
      },
    });

    await adapter.generate({
      prompt: "enterprise software?",
      modelId: "copilot",
      temperature: 0.7,
      promptVersion: "v1",
      language: "ja",
    });

    expect(capturedRequests[0]!.language).toBe("ja");
  });

  it("promptVersion sentinel still works as fallback when req.language is absent", async () => {
    const capturedRequests: Array<{ language: string }> = [];

    const client = new FixtureSerpClient(AIO_RAW, 0);
    const adapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client,
      parser: new AiOverviewParser(),
      buildSerpRequest: (prompt, lang) => {
        capturedRequests.push({ language: lang });
        return { query: prompt, language: lang };
      },
    });

    await adapter.generate({
      prompt: "best software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "lang:ko:v1", // sentinel fallback
      // language: NOT provided
    });

    // When req.language is absent, promptVersion sentinel is used as secondary fallback.
    expect(capturedRequests[0]!.language).toBe("ko");
  });
});

// ===========================================================================
// CS-01 — Structural compliance guard in SurfaceAdapter constructor
// ===========================================================================

describe("CS-01: SurfaceAdapter constructor enforces §12 compliance structurally", () => {
  const serpOnlyIds: SurfaceId[] = ["googleAio", "naverAi"];
  const scrapeIds: SurfaceId[] = ["copilot", "metaAi", "line", "kakao"];

  // --- Scrape config for a SERP-only surface MUST THROW ---

  for (const surfaceId of serpOnlyIds) {
    it(`new SurfaceAdapter({ kind: 'scrape', surfaceId: '${surfaceId}' }) throws TypeError`, () => {
      const runner = new FixtureRpaRunner(COPILOT_RAW, 0);
      expect(() =>
        new SurfaceAdapter({
          kind: "scrape",
          surfaceId,
          runner,
          parser: new CopilotParser(),
          buildRpaRequest: (p, l) => ({ targetUrl: "https://example.com", query: p, language: l }),
        })
      ).toThrow(TypeError);
    });
  }

  // --- SERP config for a non-SERP-only surface MUST THROW ---

  for (const surfaceId of scrapeIds) {
    it(`new SurfaceAdapter({ kind: 'serp', surfaceId: '${surfaceId}' }) throws TypeError`, () => {
      const client = new FixtureSerpClient(AIO_RAW, 0);
      expect(() =>
        new SurfaceAdapter({
          kind: "serp",
          surfaceId,
          client,
          parser: new AiOverviewParser(),
          buildSerpRequest: (p, l) => ({ query: p, language: l }),
        })
      ).toThrow(TypeError);
    });
  }

  // --- Valid configurations MUST NOT throw ---

  for (const surfaceId of serpOnlyIds) {
    it(`new SurfaceAdapter({ kind: 'serp', surfaceId: '${surfaceId}' }) does NOT throw`, () => {
      const client = new FixtureSerpClient(AIO_RAW, 0);
      expect(() =>
        new SurfaceAdapter({
          kind: "serp",
          surfaceId,
          client,
          parser: new AiOverviewParser(),
          buildSerpRequest: (p, l) => ({ query: p, language: l }),
        })
      ).not.toThrow();
    });
  }

  for (const surfaceId of scrapeIds) {
    it(`new SurfaceAdapter({ kind: 'scrape', surfaceId: '${surfaceId}' }) does NOT throw`, () => {
      const runner = new FixtureRpaRunner(COPILOT_RAW, 0);
      expect(() =>
        new SurfaceAdapter({
          kind: "scrape",
          surfaceId,
          runner,
          parser: new CopilotParser(),
          buildRpaRequest: (p, l) => ({ targetUrl: "https://example.com", query: p, language: l }),
        })
      ).not.toThrow();
    });
  }
});
