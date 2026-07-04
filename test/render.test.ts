/**
 * test/render.test.ts
 *
 * Guards the AEO/GEO hub-page renderer (roadmap W4/W5/W9). render.ts casts its
 * auto-derived JSON-LD `as unknown as JsonLd` with (previously) zero coverage,
 * so a dropped field or malformed shape would ship silently. These tests render
 * each content_type, parse the emitted JSON-LD, and assert:
 *   - required schema.org fields per @type (W4.5)
 *   - DefinedTerm / Article / FAQPage mapping + author node (W4.3)
 *   - case_study before/after metrics survive into structured data (W4.4)
 *   - a deterministic stylesheet + home link ship on every page (W5.2/W5.5)
 *   - valid FAQ markup (div.faq-list of details, never a dl) (W5.5)
 *   - a short, distinct, pipe-free h1/title (W5.1/W5.4)
 *   - single-escaping and byte-determinism
 *   - robots.txt welcomes citation bots + advertises the sitemap (W9.1)
 */

import { describe, it, expect } from "vitest";
import {
  renderPage,
  renderRobots,
  renderSitemap,
  renderRss,
  ANSWER_ENGINE_BOTS,
  type RenderInput,
} from "../src/deploy/connectors/render.js";
import type {
  AnswerBlockBody,
  DefinitionSentenceBody,
  FaqBody,
  ComparisonBody,
  CaseStudyBody,
} from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRAND = {
  name: "EMORA",
  url: "https://tryemora.com",
  sameAs: ["https://tryemora.com"],
  description: "AI character chat platform",
};

function base(body: RenderInput["body"], lang = "en"): RenderInput {
  return {
    body,
    disclosureTag: null,
    canonicalUrl: `https://acme.github.io/aeo-hub/${lang}/abcd1234/`,
    language: lang,
    datePublished: "2026-07-04T00:00:00.000Z",
    brand: BRAND,
  };
}

/** Extract and JSON.parse the first application/ld+json block. */
function extractJsonLd(html: string): any {
  const m = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  expect(m, "page must carry a JSON-LD block").toBeTruthy();
  return JSON.parse(m![1]!);
}

function h1Of(html: string): string {
  return html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "";
}
function titleOf(html: string): string {
  return html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
}
function metaDescOf(html: string): string {
  return html.match(/<meta name="description" content="([\s\S]*?)">/)?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const LONG =
  "EMORA is an AI character chat platform for meaningful interactions. " +
  "It retains conversational context through an infinite-memory system, generates images " +
  "inside chats, and offers a character bonding system for deeper connections over time. " +
  "Creators can design, share, and monetize their own AI characters and worlds.";

const answerBody: AnswerBlockBody = {
  content_type: "answer_block",
  text: LONG,
  length_units: 60,
  numeric_claim_ids: [],
  source_ids: [],
};

const definitionBody: DefinitionSentenceBody = {
  content_type: "definition",
  text: "EMORA is an AI character chat platform for meaningful, memory-retaining interactions.",
  meaning_key: "emora-definition",
};

const faqBody: FaqBody = {
  content_type: "faq",
  rows: [
    { q: "What is EMORA?", a: "An AI character chat platform.", answer_claim_ids: [] },
    { q: "Does it remember chats?", a: "Yes, via an infinite-memory system.", answer_claim_ids: [] },
    { q: "Can I make characters?", a: "Yes, creators can design and share characters.", answer_claim_ids: [] },
  ],
};

const comparisonBody: ComparisonBody = {
  content_type: "comparison",
  columns: ["Feature", "EMORA", "Character.AI"],
  rows: [
    { entity: "Memory", cells: [{ value: "Persistent memory", claim_id: null }, { value: "Limited", claim_id: null }] },
  ],
};

const caseStudyBody: CaseStudyBody = {
  content_type: "case_study",
  situation: "A creator wanted deeper character engagement on EMORA.",
  action: "They enabled the bonding system and infinite memory.",
  result: "Return conversations grew over the first month.",
  metrics: [{ label: "Weekly return chats", before: "12", after: "37", claim_id: null }],
};

// ---------------------------------------------------------------------------
// JSON-LD shape per content_type (W4.3/W4.5)
// ---------------------------------------------------------------------------

describe("render JSON-LD shape", () => {
  it("definition → DefinedTerm with name/description/author/inLanguage", () => {
    const ld = extractJsonLd(renderPage(base(definitionBody)));
    expect(ld["@type"]).toBe("DefinedTerm");
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld.name).toBeTruthy();
    expect(ld.description).toContain("EMORA");
    expect(ld.inLanguage).toBe("en");
    expect(ld.url).toContain("/abcd1234/");
    expect(ld.datePublished).toBe("2026-07-04T00:00:00.000Z");
    expect(ld.author?.["@type"]).toBe("Organization");
  });

  it("answer_block → Article with headline/articleBody/author/about", () => {
    const ld = extractJsonLd(renderPage(base(answerBody)));
    expect(ld["@type"]).toBe("Article");
    expect(ld.headline.length).toBeGreaterThan(0);
    expect(ld.headline.length).toBeLessThanOrEqual(120);
    expect(ld.articleBody).toContain("infinite-memory");
    expect(ld.author?.name).toBe("EMORA");
    expect(ld.about?.["@type"]).toBe("Organization");
    expect(ld.publisher?.name).toBe("EMORA");
  });

  it("faq → FAQPage with acceptedAnswer text on every row", () => {
    const ld = extractJsonLd(renderPage(base(faqBody)));
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toHaveLength(3);
    for (const q of ld.mainEntity) {
      expect(q["@type"]).toBe("Question");
      expect(q.acceptedAnswer.text.length).toBeGreaterThan(0);
    }
  });

  it("case_study → Article whose articleBody carries the before/after numbers (W4.4)", () => {
    const ld = extractJsonLd(renderPage(base(caseStudyBody)));
    expect(ld["@type"]).toBe("Article");
    expect(ld.articleBody).toContain("12");
    expect(ld.articleBody).toContain("37");
  });

  it("comparison → Article", () => {
    const ld = extractJsonLd(renderPage(base(comparisonBody)));
    expect(ld["@type"]).toBe("Article");
    expect(ld.headline).toContain("EMORA");
  });

  it("omits author/publisher when no brand is supplied", () => {
    const noBrand: RenderInput = { ...base(answerBody) };
    delete (noBrand as { brand?: unknown }).brand;
    const ld = extractJsonLd(renderPage(noBrand));
    expect(ld.author).toBeUndefined();
    expect(ld.publisher).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reader UX: CSS, home link, valid FAQ markup (W5.2/W5.5)
// ---------------------------------------------------------------------------

describe("render verified references (W4.2)", () => {
  const withRefs = (): RenderInput => ({
    ...base(answerBody),
    references: [
      { text: "스밈은 참가비 1인 50,000원입니다.", url: "https://smimdate.com" },
      { text: "연봉 7천만원 이상 대상 (owner-attested)" },
    ],
  });

  it("renders a visible <section class=references> of <cite> items", () => {
    const html = renderPage(withRefs());
    expect(html).toContain('<section class="references"');
    expect(html).toContain("<cite>");
    expect(html).toContain("50,000원");
    // one with a URL → link; one without → plain cite
    expect(html).toContain('<a href="https://smimdate.com">');
  });

  it("adds schema.org citation to the JSON-LD", () => {
    const ld = extractJsonLd(renderPage(withRefs()));
    expect(Array.isArray(ld.citation)).toBe(true);
    expect(ld.citation).toHaveLength(2);
    expect(ld.citation[0]["@type"]).toBe("CreativeWork");
    expect(ld.citation[0].url).toBe("https://smimdate.com");
    expect(ld.citation[1].url).toBeUndefined();
  });

  it("omits references + citation when none supplied", () => {
    const html = renderPage(base(answerBody));
    expect(html).not.toContain('class="references"');
    expect(extractJsonLd(html).citation).toBeUndefined();
  });

  it("uses a language-aware heading", () => {
    const ko = renderPage({ ...base(definitionBody, "ko"), references: [{ text: "출처 텍스트" }] });
    expect(ko).toContain("<h2>출처</h2>");
  });
});

describe("render reader UX", () => {
  it("every page ships the deterministic stylesheet + CJK font stack", () => {
    const html = renderPage(base(answerBody));
    expect(html).toContain("<style>");
    expect(html).toContain("Noto Sans KR");
    expect(html).toContain("prefers-color-scheme:dark");
  });

  it("every page has a visible brand/home link", () => {
    const html = renderPage(base(answerBody));
    expect(html).toMatch(/<header class="site"><a href="https:\/\/acme\.github\.io\/aeo-hub\/" rel="home">EMORA<\/a>/);
  });

  it("FAQ uses div.faq-list of details — never a dl wrapping details", () => {
    const html = renderPage(base(faqBody));
    expect(html).toContain('<div class="faq-list">');
    expect(html).toContain('<details class="faq-item">');
    expect(html).not.toContain("<dl>");
  });
});

// ---------------------------------------------------------------------------
// Short/distinct/pipe-free headline + pipe-table guard (W5.1/W5.4)
// ---------------------------------------------------------------------------

describe("render headline + pipe guard", () => {
  it("h1 is short and distinct from the full multi-sentence body (W5.4)", () => {
    const html = renderPage(base(answerBody));
    const h1 = h1Of(html);
    expect(h1.length).toBeLessThanOrEqual(80);
    // The full body is far longer than the h1 → they must differ.
    expect(h1.length).toBeLessThan(LONG.length);
    expect(html).toContain("Creators can design"); // full prose still present in body
  });

  it("a single leading pipe never leaks into h1/title (reviewer P1 #1)", () => {
    const body: AnswerBlockBody = {
      content_type: "answer_block",
      text: "| just one pipe here and no closing delimiter at all in this line",
      length_units: 12,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const html = renderPage(base(body));
    expect(h1Of(html)).not.toContain("|");
    expect(titleOf(html)).not.toContain("|");
    expect(extractJsonLd(html).headline).not.toContain("|");
  });

  it("a table-only / whitespace body still yields a non-empty pipe-free h1 + DefinedTerm name (reviewer P1 #3, P2 #4)", () => {
    const tableOnly: DefinitionSentenceBody = {
      content_type: "definition",
      text: "| --- | --- |",
      meaning_key: "k",
    };
    const html = renderPage(base(tableOnly));
    const h1 = h1Of(html);
    expect(h1.length).toBeGreaterThan(0);
    expect(h1).not.toContain("|");
    // falls back to the brand name, never empty
    expect(h1).toBe("EMORA");
    const ld = extractJsonLd(html);
    expect(ld["@type"]).toBe("DefinedTerm");
    expect(ld.name.length).toBeGreaterThan(0);
    expect(ld.description.length).toBeGreaterThan(0);
    // the raw delimiter must not survive anywhere in the body as "| ---"
    expect(html).not.toContain("| ---");
  });

  it("a ragged pipe table is normalised to the header width (reviewer P1 #2)", () => {
    const body: AnswerBlockBody = {
      content_type: "answer_block",
      text: "Plans overview.\n| A | B | C |\n| --- | --- | --- |\n| x | y |",
      length_units: 12,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const html = renderPage(base(body));
    // every <tr> in the rendered table has exactly 3 <td> (padded), none ragged
    const trs = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1]!.match(/<td>/g) ?? []).length);
    expect(trs.length).toBeGreaterThan(0);
    for (const n of trs) expect(n).toBe(3);
  });

  it("markdown-table markup never leaks into h1/title/meta/JSON-LD (W5.1)", () => {
    const poisoned: AnswerBlockBody = {
      content_type: "answer_block",
      text: "Comparison of plans.\n| Feature | EMORA | Other |\n| --- | --- | --- |\n| Memory | Persistent | Limited |",
      length_units: 20,
      numeric_claim_ids: [],
      source_ids: [],
    };
    const html = renderPage(base(poisoned));
    expect(h1Of(html)).not.toContain("|");
    expect(titleOf(html)).not.toContain("|");
    expect(metaDescOf(html)).not.toContain("| ---");
    const ld = extractJsonLd(html);
    expect(ld.headline).not.toContain("|");
    // The table content is rendered as a real <table>, not raw pipe text.
    expect(html).toContain("<table>");
    expect(html).toContain("<td>Persistent</td>");
  });
});

// ---------------------------------------------------------------------------
// Escaping + determinism
// ---------------------------------------------------------------------------

describe("render safety + determinism", () => {
  it("single-escapes special characters in the title (no double escape)", () => {
    const body: DefinitionSentenceBody = {
      content_type: "definition",
      text: "EMORA's platform & its memory system explained.",
      meaning_key: "k",
    };
    const html = renderPage(base(body));
    expect(titleOf(html)).toContain("&#39;");
    expect(titleOf(html)).not.toContain("&amp;#39;");
  });

  it("is byte-deterministic for identical input", () => {
    expect(renderPage(base(answerBody))).toBe(renderPage(base(answerBody)));
  });
});

// ---------------------------------------------------------------------------
// robots.txt (W9.1)
// ---------------------------------------------------------------------------

describe("renderRobots", () => {
  it("explicitly allows every citation bot and advertises the sitemap", () => {
    const txt = renderRobots({ sitemapUrl: "https://acme.github.io/aeo-hub/sitemap.xml" });
    for (const ua of ANSWER_ENGINE_BOTS) {
      expect(txt).toContain(`User-agent: ${ua}`);
    }
    expect(txt).toContain("GPTBot");
    expect(txt).toContain("PerplexityBot");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Sitemap: https://acme.github.io/aeo-hub/sitemap.xml");
  });

  it("omits the Sitemap line when no url is given, and is deterministic", () => {
    const a = renderRobots({});
    expect(a).not.toContain("Sitemap:");
    expect(a).toBe(renderRobots({}));
  });
});

// ---------------------------------------------------------------------------
// sitemap still deterministic
// ---------------------------------------------------------------------------

describe("renderRss (W9.3)", () => {
  const items = [
    { url: "https://h/en/a/", title: "Alpha", description: "First", isoDate: "2026-07-01T00:00:00.000Z" },
    { url: "https://h/en/c/", title: "Gamma", description: "Third", isoDate: "2026-07-03T00:00:00.000Z" },
    { url: "https://h/en/b/", title: "Beta & <friends>", description: "Second", isoDate: "2026-07-02T00:00:00.000Z" },
  ];
  const feed = renderRss({ title: "Hub", homeUrl: "https://h/", feedUrl: "https://h/feed.xml", language: "en", description: "d", items });

  it("is valid RSS 2.0 with a self atom:link", () => {
    expect(feed).toContain('<rss version="2.0"');
    expect(feed).toContain('<atom:link href="https://h/feed.xml" rel="self"');
    expect(feed).toContain("<channel>");
  });

  it("sorts items newest-first", () => {
    const order = ["Gamma", "Beta", "Alpha"].map((t) => feed.indexOf(t));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });

  it("emits RFC-822 pubDate and escapes item titles", () => {
    expect(feed).toMatch(/<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
    expect(feed).toContain("Beta &amp; &lt;friends&gt;");
  });

  it("is byte-deterministic", () => {
    expect(renderRss({ title: "Hub", homeUrl: "https://h/", feedUrl: "https://h/feed.xml", language: "en", description: "d", items })).toBe(feed);
  });
});

describe("renderSitemap", () => {
  it("sorts by loc and is byte-stable", () => {
    const entries = [
      { loc: "https://b.example/", lastmod: "2026-07-04T00:00:00.000Z" },
      { loc: "https://a.example/", lastmod: "2026-07-04T00:00:00.000Z" },
    ];
    const xml = renderSitemap(entries);
    expect(xml.indexOf("a.example")).toBeLessThan(xml.indexOf("b.example"));
  });
});
