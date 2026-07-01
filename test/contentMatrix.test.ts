/**
 * test/contentMatrix.test.ts
 *
 * T06 — ContentMatrix builder (coverage+cost contract) tests.
 *
 * Acceptance criteria from phase2-tasks.json T06:
 *   1. Matrix never exceeds max_content_assets_per_run or max_formats.
 *   2. 18-language capability but generation capped to the configured/weighted
 *      set (e.g. 14).
 *   3. High-weight languages get more formats than low-weight (thinned) ones;
 *      pure/deterministic.
 *
 * Also tests:
 *   - Language reconciliation (BrandBrief.detectedLanguages + template.languages)
 *   - Format thinning for low-weight languages (definition + answer_block only)
 *   - Channel × format legality (JSON-LD only on owned_net)
 *   - phrasingGroupSeed is deterministic
 *   - summary is printable (non-empty string)
 *   - emptyResult when no languages
 */

import { describe, it, expect } from "vitest";
import {
  buildContentMatrix,
  reconcileLanguages,
  FORMAT_TO_CONTENT_TYPE,
  HIGH_WEIGHT_THRESHOLD_RATIO,
  OVER_GEN_FACTOR,
  type ContentMatrixCaps,
  type ContentMatrixResult,
} from "../src/content/contentMatrix.js";
import type { BrandBrief } from "../src/generate/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid BrandBrief fixture for testing.
 */
function makeBrief(
  languages: Array<{ code: string; weight: number; rationale?: string }> = [
    { code: "en", weight: 1.0, rationale: "primary" },
  ]
): BrandBrief {
  return {
    brandName: "TestBrand",
    brandAliases: ["TB", "Test Brand"],
    category: "AI companion app",
    industryKey: "ai-companion",
    positioning: "Leading AI companion with emotional memory.",
    icp: ["young adults", "solo travelers"],
    productAttributes: ["voice chat", "emotion tracking", "multilingual"],
    seedCompetitors: [{ name: "Character.AI", aliases: [] }],
    detectedLanguages: languages.map((l) => ({
      code: l.code,
      weight: l.weight,
      rationale: l.rationale ?? `detected ${l.code}`,
    })),
    confidence: 0.9,
  };
}

/**
 * Build a template language list.
 */
function makeTplLangs(
  entries: Array<{ code: string; weight: number }>
): Array<{ code: string; weight: number }> {
  return entries;
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: matrix never exceeds caps
// ---------------------------------------------------------------------------

describe("Acceptance criterion 1 — matrix never exceeds caps", () => {
  it("respects max_content_assets_per_run", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.9 },
      { code: "ja", weight: 0.8 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.9 },
      { code: "ja", weight: 0.8 },
    ]) };
    const caps: ContentMatrixCaps = { max_content_assets_per_run: 20 };

    const result = buildContentMatrix(brief, template, caps);
    expect(result.cells.length).toBeLessThanOrEqual(20);
    expect(result.totalCells).toBeLessThanOrEqual(20);
  });

  it("respects max_formats by excluding lowest-priority formats first", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };
    const caps: ContentMatrixCaps = { max_formats: 2 };

    const result = buildContentMatrix(brief, template, caps);
    // Formats should be limited to 2 (definition_sentence + answer_block)
    expect(result.formatSet.length).toBeLessThanOrEqual(2);
  });

  it("works with max_content_assets_per_run of 1 (extreme cap)", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.9 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.9 },
    ]) };
    const caps: ContentMatrixCaps = { max_content_assets_per_run: 1 };

    const result = buildContentMatrix(brief, template, caps);
    expect(result.cells.length).toBeLessThanOrEqual(1);
  });

  it("uses defaults when caps are absent (no throw)", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    // No caps provided — should use defaults (200 assets, 8 formats)
    const result = buildContentMatrix(brief, template);
    expect(result.cells.length).toBeGreaterThan(0);
    expect(result.totalCells).toBeGreaterThan(0);
  });

  it("null cap values use defaults", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };
    const caps: ContentMatrixCaps = {
      max_content_assets_per_run: null,
      max_formats: null,
    };
    const result = buildContentMatrix(brief, template, caps);
    expect(result.cells.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: 18-language cap + configured/weighted set
// ---------------------------------------------------------------------------

describe("Acceptance criterion 2 — language capping", () => {
  it("caps to maxLanguages (14) when 18 are supplied", () => {
    // Emora-style: 18 languages in brief, customer uses 14.
    const langs18 = [
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.95 },
      { code: "ja", weight: 0.9 },
      { code: "zh-TW", weight: 0.85 },
      { code: "zh-CN", weight: 0.8 },
      { code: "fr", weight: 0.75 },
      { code: "de", weight: 0.7 },
      { code: "es", weight: 0.65 },
      { code: "pt", weight: 0.6 },
      { code: "it", weight: 0.55 },
      { code: "ar", weight: 0.5 },
      { code: "ru", weight: 0.45 },
      { code: "tl", weight: 0.3 },
      { code: "vi", weight: 0.25 },
      { code: "th", weight: 0.2 },
      { code: "id", weight: 0.15 },
      { code: "nl", weight: 0.1 },
      { code: "sv", weight: 0.05 },
    ];
    const brief = makeBrief(langs18);
    // Template has 14 languages (emora-style)
    const template = {
      languages: makeTplLangs(langs18.slice(0, 14)),
    };
    const caps: ContentMatrixCaps = { maxLanguages: 14 };

    const result = buildContentMatrix(brief, template, caps);
    const languages = new Set(result.cells.map((c) => c.language));
    expect(languages.size).toBeLessThanOrEqual(14);
    expect(result.languageAllocations.length).toBeLessThanOrEqual(14);
  });

  it("takes top-weighted languages when trimming", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.8 },
      { code: "ja", weight: 0.6 },
      { code: "fr", weight: 0.2 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.8 },
      { code: "ja", weight: 0.6 },
      { code: "fr", weight: 0.2 },
    ]) };
    const caps: ContentMatrixCaps = { maxLanguages: 2 };

    const result = buildContentMatrix(brief, template, caps);
    const languages = [...new Set(result.cells.map((c) => c.language))];
    // Should have en and ko (top 2 by weight)
    expect(languages).toContain("en");
    expect(languages).toContain("ko");
    expect(languages).not.toContain("fr");
    expect(languages.length).toBeLessThanOrEqual(2);
  });

  it("never exceeds 18-language capability", () => {
    // Build 20 detected languages; max supported is 18.
    const langs20 = Array.from({ length: 20 }, (_, i) => ({
      code: `lang${i}`,
      weight: 1.0 - i * 0.04,
    }));
    const brief = makeBrief(langs20);
    const template = { languages: makeTplLangs(langs20) };

    const result = buildContentMatrix(brief, template, {});
    const languages = new Set(result.cells.map((c) => c.language));
    expect(languages.size).toBeLessThanOrEqual(18);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: high-weight gets more formats than low-weight
// ---------------------------------------------------------------------------

describe("Acceptance criterion 3 — high/low weight format thinning", () => {
  it("high-weight language gets more formats than low-weight language", () => {
    // en = weight 1.0 (high), sv = weight 0.05 (low — below 50% of 1.0)
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "sv", weight: 0.05 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "sv", weight: 0.05 },
    ]) };

    const result = buildContentMatrix(brief, template, {});

    const enFormats = new Set(
      result.cells.filter((c) => c.language === "en").map((c) => c.format)
    );
    const svFormats = new Set(
      result.cells.filter((c) => c.language === "sv").map((c) => c.format)
    );

    expect(enFormats.size).toBeGreaterThan(svFormats.size);
  });

  it("low-weight language only gets definition_sentence + answer_block (thinned)", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "xx", weight: 0.01 }, // well below 50% threshold
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "xx", weight: 0.01 },
    ]) };

    const result = buildContentMatrix(brief, template, {});
    const xxFormats = new Set(
      result.cells.filter((c) => c.language === "xx").map((c) => c.format)
    );

    // Should only have thinned formats
    expect(xxFormats.has("definition_sentence")).toBe(true);
    expect(xxFormats.has("answer_block")).toBe(true);
    // Should NOT have higher-order formats
    expect(xxFormats.has("faq_table")).toBe(false);
    expect(xxFormats.has("comparison_table")).toBe(false);
    expect(xxFormats.has("case_study")).toBe(false);
  });

  it("high-weight language allocation tier is 'high'", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    const enAlloc = result.languageAllocations.find((la) => la.language === "en");
    expect(enAlloc).toBeDefined();
    expect(enAlloc?.tier).toBe("high");
  });

  it("low-weight language allocation tier is 'low'", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "zz", weight: 0.1 }, // 10% of max — below 50% threshold
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "zz", weight: 0.1 },
    ]) };

    const result = buildContentMatrix(brief, template, {});
    const zzAlloc = result.languageAllocations.find((la) => la.language === "zz");
    expect(zzAlloc).toBeDefined();
    expect(zzAlloc?.tier).toBe("low");
  });

  it("is deterministic — same inputs produce same output", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.8 },
      { code: "ja", weight: 0.6 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.8 },
      { code: "ja", weight: 0.6 },
    ]) };

    const r1 = buildContentMatrix(brief, template, {});
    const r2 = buildContentMatrix(brief, template, {});

    expect(r1.cells.length).toBe(r2.cells.length);
    expect(r1.totalCells).toBe(r2.totalCells);
    expect(r1.formatSet).toEqual(r2.formatSet);
    // Cell-by-cell phrasingGroupSeed must match
    for (let i = 0; i < r1.cells.length; i++) {
      expect(r1.cells[i]!.phrasingGroupSeed).toBe(r2.cells[i]!.phrasingGroupSeed);
    }
  });
});

// ---------------------------------------------------------------------------
// Channel × format legality enforcement
// ---------------------------------------------------------------------------

describe("Channel × format legality", () => {
  it("JSON-LD formats only appear on owned_net cells", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    const jsonldCells = result.cells.filter((c) =>
      c.format.startsWith("jsonld_")
    );

    for (const cell of jsonldCells) {
      expect(cell.channel_class).toBe("owned_net");
    }
  });

  it("comparison_table does not appear on social cells", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    const socialComparison = result.cells.filter(
      (c) => c.channel_class === "social" && c.format === "comparison_table"
    );
    expect(socialComparison.length).toBe(0);
  });

  it("faq_table does not appear on social cells", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    const socialFaq = result.cells.filter(
      (c) => c.channel_class === "social" && c.format === "faq_table"
    );
    expect(socialFaq.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ContentCell shape correctness
// ---------------------------------------------------------------------------

describe("ContentCell shape", () => {
  it("every cell has contentType matching its format via FORMAT_TO_CONTENT_TYPE", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    for (const cell of result.cells) {
      expect(cell.contentType).toBe(FORMAT_TO_CONTENT_TYPE[cell.format]);
    }
  });

  it("every cell has a non-empty phrasingGroupSeed", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    for (const cell of result.cells) {
      expect(cell.phrasingGroupSeed.length).toBeGreaterThan(0);
    }
  });

  it("every cell has a positive targetVariants", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    for (const cell of result.cells) {
      expect(cell.targetVariants).toBeGreaterThan(0);
    }
  });

  it("phrasingGroupSeed is unique per (format, language, channel, variant) coord", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.8 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.8 },
    ]) };

    const result = buildContentMatrix(brief, template, {});
    const seeds = result.cells.map((c) => c.phrasingGroupSeed);
    const unique = new Set(seeds);
    expect(unique.size).toBe(seeds.length);
  });
});

// ---------------------------------------------------------------------------
// Language reconciliation
// ---------------------------------------------------------------------------

describe("reconcileLanguages", () => {
  it("template languages take priority over detected", () => {
    const detected = [
      { code: "en", weight: 0.5, rationale: "detected" },
      { code: "ko", weight: 0.3, rationale: "detected" },
    ];
    const template = [
      { code: "en", weight: 1.0 }, // override en weight to 1.0
    ];

    const result = reconcileLanguages(detected, template);
    const en = result.find((l) => l.language === "en");
    expect(en?.weight).toBe(1.0); // template wins
  });

  it("detected languages not in template are added", () => {
    const detected = [
      { code: "en", weight: 1.0, rationale: "primary" },
      { code: "fr", weight: 0.5, rationale: "detected" },
    ];
    const template = [{ code: "en", weight: 1.0 }];

    const result = reconcileLanguages(detected, template);
    const codes = result.map((l) => l.language);
    expect(codes).toContain("en");
    expect(codes).toContain("fr");
  });

  it("returns only template languages when detected is empty", () => {
    const result = reconcileLanguages([], [{ code: "en", weight: 1.0 }]);
    expect(result.length).toBe(1);
    expect(result[0]?.language).toBe("en");
  });

  it("returns only detected when template is empty", () => {
    const detected = [
      { code: "ko", weight: 0.9, rationale: "detected" },
    ];
    const result = reconcileLanguages(detected, []);
    expect(result.length).toBe(1);
    expect(result[0]?.language).toBe("ko");
  });
});

// ---------------------------------------------------------------------------
// Printable summary
// ---------------------------------------------------------------------------

describe("Printable summary", () => {
  it("summary is a non-empty string", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("summary includes language names and cell count", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    expect(result.summary).toContain("en");
    expect(result.summary).toContain("cells");
  });

  it("summary includes total cells count", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };

    const result = buildContentMatrix(brief, template, {});
    // The summary should mention the total
    expect(result.summary).toContain(String(result.totalCells));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("returns empty result when template has no languages", () => {
    const brief = makeBrief([]); // no detected languages either
    const template = { languages: [] };

    const result = buildContentMatrix(brief, template, {});
    expect(result.cells.length).toBe(0);
    expect(result.totalCells).toBe(0);
    expect(result.languageAllocations.length).toBe(0);
  });

  it("single language + single format cap produces non-empty output", () => {
    const brief = makeBrief([{ code: "en", weight: 1.0 }]);
    const template = { languages: makeTplLangs([{ code: "en", weight: 1.0 }]) };
    const caps: ContentMatrixCaps = {
      max_content_assets_per_run: 100,
      max_formats: 1,
    };

    const result = buildContentMatrix(brief, template, caps);
    expect(result.cells.length).toBeGreaterThan(0);
    expect(result.formatSet.length).toBeLessThanOrEqual(1);
  });

  it("multiple languages all have cells in the output", () => {
    const brief = makeBrief([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.9 },
    ]);
    const template = { languages: makeTplLangs([
      { code: "en", weight: 1.0 },
      { code: "ko", weight: 0.9 },
    ]) };

    const result = buildContentMatrix(brief, template, {});
    const langs = new Set(result.cells.map((c) => c.language));
    expect(langs.has("en")).toBe(true);
    expect(langs.has("ko")).toBe(true);
  });

  it("FORMAT_TO_CONTENT_TYPE covers all 8 formats", () => {
    const expectedFormats = [
      "definition_sentence",
      "answer_block",
      "faq_table",
      "comparison_table",
      "case_study",
      "jsonld_org",
      "jsonld_faqpage",
      "jsonld_article",
    ];
    for (const fmt of expectedFormats) {
      expect(FORMAT_TO_CONTENT_TYPE[fmt as keyof typeof FORMAT_TO_CONTENT_TYPE]).toBeDefined();
    }
  });

  it("HIGH_WEIGHT_THRESHOLD_RATIO is between 0 and 1", () => {
    expect(HIGH_WEIGHT_THRESHOLD_RATIO).toBeGreaterThan(0);
    expect(HIGH_WEIGHT_THRESHOLD_RATIO).toBeLessThan(1);
  });

  it("OVER_GEN_FACTOR is 1.3", () => {
    expect(OVER_GEN_FACTOR).toBe(1.3);
  });
});

// ---------------------------------------------------------------------------
// Emora scenario: 14-language customer with k-beauty use case
// ---------------------------------------------------------------------------

describe("Emora 14-language scenario", () => {
  const langs14 = [
    { code: "en", weight: 1.0 },
    { code: "ko", weight: 0.95 },
    { code: "ja", weight: 0.9 },
    { code: "zh-TW", weight: 0.85 },
    { code: "zh-CN", weight: 0.8 },
    { code: "fr", weight: 0.75 },
    { code: "de", weight: 0.7 },
    { code: "es", weight: 0.65 },
    { code: "pt", weight: 0.6 },
    { code: "it", weight: 0.55 },
    { code: "ar", weight: 0.5 },
    { code: "ru", weight: 0.45 },
    { code: "tl", weight: 0.3 },
    { code: "vi", weight: 0.25 },
  ];

  it("generates cells for all 14 languages", () => {
    const brief = makeBrief(langs14);
    const template = { languages: makeTplLangs(langs14) };

    // Use a large cap so all 14 languages fit (natural expansion is ~700 cells
    // for 14 langs with all formats across all channels and 2x over-gen).
    const result = buildContentMatrix(brief, template, {
      max_content_assets_per_run: 2000,
    });

    const languages = new Set(result.cells.map((c) => c.language));
    expect(languages.size).toBe(14);
  });

  it("top-weight languages (en, ko, ja) are tier 'high'", () => {
    const brief = makeBrief(langs14);
    const template = { languages: makeTplLangs(langs14) };

    const result = buildContentMatrix(brief, template, {
      max_content_assets_per_run: 2000,
    });

    for (const lang of ["en", "ko", "ja"]) {
      const alloc = result.languageAllocations.find((la) => la.language === lang);
      expect(alloc?.tier).toBe("high");
    }
  });

  it("very low-weight languages (tl, vi) are tier 'low'", () => {
    const brief = makeBrief(langs14);
    const template = { languages: makeTplLangs(langs14) };

    const result = buildContentMatrix(brief, template, {
      max_content_assets_per_run: 2000,
    });

    // tl (0.3) is 30% of max (1.0), below the 50% threshold → low
    for (const lang of ["tl", "vi"]) {
      const alloc = result.languageAllocations.find((la) => la.language === lang);
      expect(alloc?.tier).toBe("low");
    }
  });

  it("en (high) has more formats than tl (low)", () => {
    const brief = makeBrief(langs14);
    const template = { languages: makeTplLangs(langs14) };

    const result = buildContentMatrix(brief, template, {
      max_content_assets_per_run: 2000,
    });

    const enAlloc = result.languageAllocations.find((la) => la.language === "en");
    const tlAlloc = result.languageAllocations.find((la) => la.language === "tl");
    expect(enAlloc!.formats.length).toBeGreaterThan(tlAlloc!.formats.length);
  });

  it("never exceeds configured max_content_assets_per_run=200", () => {
    const brief = makeBrief(langs14);
    const template = { languages: makeTplLangs(langs14) };

    // With 14 languages, natural expansion greatly exceeds 200.
    // The cap must be enforced strictly.
    const result = buildContentMatrix(brief, template, {
      max_content_assets_per_run: 200,
    });

    expect(result.cells.length).toBeLessThanOrEqual(200);
    expect(result.totalCells).toBeLessThanOrEqual(200);
  });
});
