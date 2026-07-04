/**
 * test/deploy/render-jsonld.test.ts
 *
 * T18 — Deterministic HTML + JSON-LD render tests.
 *
 * Acceptance criteria:
 *   - renderPage output is deterministic / byte-identical on re-run (same inputs → same bytes).
 *   - disclosure_tag is rendered into the artifact (§7#6).
 *   - JSON-LD is embedded as <script type="application/ld+json"> with sorted keys.
 *   - All ContentBody content_type values produce valid HTML (at least).
 *   - renderSitemap is deterministic and sorted by loc.
 *   - A null disclosure_tag produces no disclosure banner.
 *   - HTML entities are correctly escaped in title/body text.
 *
 * DESIGN-phase3.md §"Owned-Net (real today)" step 3. SPEC §7#6.
 */

import { describe, it, expect } from "vitest";

import { renderPage, renderSitemap } from "../../src/deploy/connectors/render.js";
import type { RenderInput, SitemapEntry } from "../../src/deploy/connectors/render.js";
import type { ContentBody, JsonLd } from "../../src/content/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_DATE = "2025-06-15T12:00:00.000Z";
const CANONICAL = "https://hub.example.com/en/test-slug/";
const LANG = "en";

function makeInput(
  body: ContentBody,
  overrides: Partial<RenderInput> = {}
): RenderInput {
  return {
    body,
    disclosureTag: null,
    canonicalUrl: CANONICAL,
    language: LANG,
    datePublished: FIXED_DATE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Determinism — same inputs → byte-identical output
// ---------------------------------------------------------------------------

describe("renderPage — determinism / byte-identical re-render", () => {
  it("produces byte-identical output for definition content_type across two calls", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA is an AI character chat platform supporting 14 languages.",
      meaning_key: "emora-def",
    };
    const input = makeInput(body);
    const out1 = renderPage(input);
    const out2 = renderPage(input);
    expect(out1).toBe(out2);
  });

  it("produces byte-identical output for answer_block across two calls", () => {
    const body: ContentBody = {
      content_type: "answer_block",
      text: "EMORA enables users to build AI characters with persistent memory and multilingual support across 14 languages.",
      length_units: 18,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const input = makeInput(body);
    const out1 = renderPage(input);
    const out2 = renderPage(input);
    expect(out1).toBe(out2);
  });

  it("produces byte-identical output for faq content_type", () => {
    const body: ContentBody = {
      content_type: "faq",
      rows: [
        { q: "What is EMORA?", a: "An AI character chat platform.", answer_claim_ids: [] },
        { q: "What languages?", a: "14 languages.", answer_claim_ids: [] },
        { q: "Is it free?", a: "Yes, there is a free tier.", answer_claim_ids: [] },
      ],
    };
    const input = makeInput(body);
    const out1 = renderPage(input);
    const out2 = renderPage(input);
    expect(out1).toBe(out2);
  });

  it("produces byte-identical output for comparison content_type", () => {
    const body: ContentBody = {
      content_type: "comparison",
      columns: ["Feature", "EMORA", "Competitor"],
      rows: [
        {
          entity: "EMORA",
          cells: [{ value: "AI Chat", claim_id: null }, { value: "Yes", claim_id: null }],
        },
      ],
    };
    const input = makeInput(body);
    const out1 = renderPage(input);
    const out2 = renderPage(input);
    expect(out1).toBe(out2);
  });

  it("produces byte-identical output for case_study content_type", () => {
    const body: ContentBody = {
      content_type: "case_study",
      situation: "Customer needed multilingual AI chat.",
      action: "Deployed EMORA with 14 language support.",
      result: "Achieved 30% engagement increase.",
      metrics: [{ label: "Engagement", before: "10%", after: "40%", claim_id: null }],
    };
    const input = makeInput(body);
    const out1 = renderPage(input);
    const out2 = renderPage(input);
    expect(out1).toBe(out2);
  });

  it("JSON-LD keys are sorted for determinism", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA is an AI platform.",
      meaning_key: "emora-def",
    };
    const jsonLd: JsonLd = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "EMORA",
      url: { deferred: true, role: "owned_hub" },
      description: "AI character chat platform",
    };
    const input = makeInput(body, { jsonLd });
    const out1 = renderPage(input);
    const out2 = renderPage(input);
    expect(out1).toBe(out2);
    // Keys should appear in sorted order inside the JSON-LD block
    const ldStart = out1.indexOf('"@context"');
    const ldEnd = out1.indexOf("</script>", ldStart);
    const ldText = out1.slice(ldStart, ldEnd);
    // "@context" < "@type" < "description" < "name" < "url" (sorted)
    const ctxPos = ldText.indexOf('"@context"');
    const typePos = ldText.indexOf('"@type"');
    const descPos = ldText.indexOf('"description"');
    const namePos = ldText.indexOf('"name"');
    const urlPos = ldText.indexOf('"url"');
    expect(ctxPos).toBeLessThan(typePos);
    expect(typePos).toBeLessThan(descPos);
    expect(descPos).toBeLessThan(namePos);
    expect(namePos).toBeLessThan(urlPos);
  });
});

// ---------------------------------------------------------------------------
// 2. Disclosure tag is rendered into the artifact (§7#6)
// ---------------------------------------------------------------------------

describe("renderPage — disclosure_tag embedded in artifact (§7#6)", () => {
  it("renders disclosure_tag into the HTML output when present", () => {
    const body: ContentBody = {
      content_type: "answer_block",
      text: "EMORA is great.",
      length_units: 3,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const input = makeInput(body, { disclosureTag: "Sponsored" });
    const html = renderPage(input);
    expect(html).toContain("Sponsored");
    expect(html).toContain("disclosure");
  });

  it("renders no disclosure banner when disclosureTag is null", () => {
    const body: ContentBody = {
      content_type: "answer_block",
      text: "EMORA is great.",
      length_units: 3,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const input = makeInput(body, { disclosureTag: null });
    const html = renderPage(input);
    // No disclosure aside element when tag is null
    expect(html).not.toContain('class="disclosure"');
  });

  it("HTML-escapes the disclosure_tag (no XSS)", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA is an AI platform.",
      meaning_key: "emora-def",
    };
    const xssTag = '<script>alert("xss")</script>';
    const input = makeInput(body, { disclosureTag: xssTag });
    const html = renderPage(input);
    // The raw <script> tag should NOT appear literally in the output
    expect(html).not.toContain('<script>alert');
    // But the escaped version should appear
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// 3. JSON-LD block is embedded in the page
// ---------------------------------------------------------------------------

describe("renderPage — JSON-LD embedded as <script type=application/ld+json>", () => {
  it("embeds JSON-LD script block when jsonLd is provided", () => {
    const body: ContentBody = {
      content_type: "answer_block",
      text: "EMORA supports 14 languages.",
      length_units: 5,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const jsonLd: JsonLd = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "EMORA",
      url: { deferred: true, role: "owned_hub" },
    };
    const input = makeInput(body, { jsonLd });
    const html = renderPage(input);
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type"');
    expect(html).toContain('"Organization"');
    expect(html).toContain('"EMORA"');
  });

  it("auto-derives a DefinedTerm JSON-LD block for a definition when jsonLd is absent (AEO structured data)", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA is an AI platform.",
      meaning_key: "emora-def",
    };
    const input = makeInput(body);
    // No explicit jsonLd → renderer derives schema.org structured data from the
    // body so every page carries it (the #1 AEO/GEO citation lever). A definition
    // maps to DefinedTerm (W4.3), not Article.
    const html = renderPage(input);
    expect(html).toContain('"application/ld+json"');
    expect(html).toContain('"DefinedTerm"');
    expect(html).toContain('"description"');
    expect(html).toContain('"inLanguage"');
  });

  it("auto-derives an Article JSON-LD block for an answer_block when jsonLd is absent", () => {
    const body: ContentBody = {
      content_type: "answer_block",
      text: "EMORA is an AI character chat platform with an infinite-memory system.",
      length_units: 12,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const html = renderPage(makeInput(body));
    expect(html).toContain('"Article"');
    expect(html).toContain('"articleBody"');
    expect(html).toContain('"inLanguage"');
  });

  it("auto-derives a FAQPage JSON-LD block for faq content_type", () => {
    const body: ContentBody = {
      content_type: "faq",
      rows: [
        { q: "What is EMORA?", a: "An AI character chat platform.", answer_claim_ids: [] },
      ],
    };
    const html = renderPage(makeInput(body));
    expect(html).toContain('"FAQPage"');
    expect(html).toContain('"acceptedAnswer"');
  });

  it("embeds brand Organization + About blurb when brand is supplied", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "스밈은 검증된 회원 로테이션 소개팅 서비스입니다.",
      meaning_key: "smim-def",
    };
    const html = renderPage(
      makeInput(body, {
        language: "ko",
        brand: { name: "스밈 (SMIM)", url: "https://smimdate.com", sameAs: ["https://smimdate.com"], description: "로테이션 소개팅" },
      }),
    );
    expect(html).toContain('"Organization"');
    expect(html).toContain("smimdate.com");
    expect(html).toContain('class="about"');
    expect(html).toContain("<h1>");
    expect(html).toContain('name="description"');
  });

  it("datePublished is embedded in the page meta tag", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA is an AI platform.",
      meaning_key: "emora-def",
    };
    const input = makeInput(body, { datePublished: "2025-06-15T12:00:00.000Z" });
    const html = renderPage(input);
    expect(html).toContain("2025-06-15T12:00:00.000Z");
  });

  it("canonical URL is embedded in <link rel=canonical>", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA is an AI platform.",
      meaning_key: "emora-def",
    };
    const input = makeInput(body, { canonicalUrl: "https://hub.example.com/en/test/" });
    const html = renderPage(input);
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("https://hub.example.com/en/test/");
  });

  it("language is set in <html lang> attribute", () => {
    const body: ContentBody = {
      content_type: "definition",
      text: "EMORA는 AI 플랫폼입니다.",
      meaning_key: "emora-def-ko",
    };
    const input = makeInput(body, { language: "ko" });
    const html = renderPage(input);
    expect(html).toContain('lang="ko"');
  });
});

// ---------------------------------------------------------------------------
// 4. renderSitemap — deterministic sorted XML
// ---------------------------------------------------------------------------

describe("renderSitemap — deterministic sorted XML", () => {
  it("produces byte-identical output across two calls with same entries", () => {
    const entries: SitemapEntry[] = [
      { loc: "https://hub.example.com/en/slug-b/", lastmod: "2025-06-01" },
      { loc: "https://hub.example.com/en/slug-a/", lastmod: "2025-06-02" },
    ];
    const xml1 = renderSitemap(entries);
    const xml2 = renderSitemap(entries);
    expect(xml1).toBe(xml2);
  });

  it("sorts entries by loc for byte-identical determinism regardless of input order", () => {
    const unordered: SitemapEntry[] = [
      { loc: "https://hub.example.com/en/zzz/", lastmod: "2025-06-03" },
      { loc: "https://hub.example.com/en/aaa/", lastmod: "2025-06-01" },
      { loc: "https://hub.example.com/en/mmm/", lastmod: "2025-06-02" },
    ];
    const ordered: SitemapEntry[] = [
      { loc: "https://hub.example.com/en/aaa/", lastmod: "2025-06-01" },
      { loc: "https://hub.example.com/en/mmm/", lastmod: "2025-06-02" },
      { loc: "https://hub.example.com/en/zzz/", lastmod: "2025-06-03" },
    ];
    const xml1 = renderSitemap(unordered);
    const xml2 = renderSitemap(ordered);
    expect(xml1).toBe(xml2);
  });

  it("produces valid XML sitemap structure", () => {
    const entries: SitemapEntry[] = [
      { loc: "https://hub.example.com/en/test/", lastmod: "2025-06-01" },
    ];
    const xml = renderSitemap(entries);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<urlset xmlns=');
    expect(xml).toContain('<url>');
    expect(xml).toContain('<loc>https://hub.example.com/en/test/</loc>');
    expect(xml).toContain('<lastmod>2025-06-01</lastmod>');
    expect(xml).toContain('</urlset>');
  });

  it("handles empty entries list", () => {
    const xml = renderSitemap([]);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<urlset');
    expect(xml).toContain('</urlset>');
    expect(xml).not.toContain('<url>');
  });

  it("HTML-escapes special characters in loc/lastmod", () => {
    const entries: SitemapEntry[] = [
      { loc: "https://hub.example.com/en/test&more/", lastmod: "2025-06-01" },
    ];
    const xml = renderSitemap(entries);
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("test&more");
  });
});

// ---------------------------------------------------------------------------
// 5. All ContentBody types render without error
// ---------------------------------------------------------------------------

describe("renderPage — all ContentBody types handled", () => {
  const testCases: Array<{ name: string; body: ContentBody }> = [
    {
      name: "definition",
      body: {
        content_type: "definition",
        text: "EMORA is an AI character chat platform.",
        meaning_key: "emora-def",
      },
    },
    {
      name: "answer_block",
      body: {
        content_type: "answer_block",
        text: "EMORA supports 14 languages for native AI character creation.",
        length_units: 10,
        numeric_claim_ids: [],
        source_ids: [],
      },
    },
    {
      name: "faq",
      body: {
        content_type: "faq",
        rows: [
          { q: "What is EMORA?", a: "An AI chat platform.", answer_claim_ids: [] },
          { q: "What languages?", a: "14 languages.", answer_claim_ids: [] },
          { q: "How much?", a: "Free tier available.", answer_claim_ids: [] },
        ],
      },
    },
    {
      name: "comparison",
      body: {
        content_type: "comparison",
        columns: ["Feature", "EMORA"],
        rows: [
          { entity: "EMORA", cells: [{ value: "Yes", claim_id: null }] },
        ],
      },
    },
    {
      name: "case_study",
      body: {
        content_type: "case_study",
        situation: "Needed multilingual support.",
        action: "Deployed EMORA.",
        result: "30% increase.",
        metrics: [],
      },
    },
    {
      name: "jsonld",
      body: {
        content_type: "jsonld",
        schema_type: "Organization",
        json: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "EMORA",
          url: { deferred: true, role: "owned_hub" },
        },
      },
    },
  ];

  for (const { name, body } of testCases) {
    it(`renders ${name} content_type without throwing`, () => {
      const input = makeInput(body);
      expect(() => renderPage(input)).not.toThrow();
      const html = renderPage(input);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<main>");
    });
  }
});
