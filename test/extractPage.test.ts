/**
 * test/extractPage.test.ts
 *
 * Tests for src/generate/extractPage.ts (T06).
 *
 * Acceptance criteria:
 *  ✓ Pulls title / meta / og / JSON-LD / hreflang from a fixture HTML
 *  ✓ Truncates to the char bound (~7 K)
 *  ✓ Returns empty-but-valid signals for a JS-shell page (enables graceful degrade)
 *  ✓ extractPage.test.ts passes on fixtures
 */

import { describe, it, expect } from "vitest";
import { extractPage, type ExtractedSignals } from "../src/generate/extractPage.js";

// ---------------------------------------------------------------------------
// Fixture HTML — a realistic EMORA-style multilingual SaaS landing page
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>EMORA — Your AI Companion App</title>
  <meta name="description" content="EMORA is the AI companion that remembers you. Available in 14 languages.">
  <meta property="og:title" content="EMORA - AI Companion">
  <meta property="og:description" content="The AI companion with long-term emotional memory.">
  <meta property="og:image" content="https://emora.app/og-image.jpg">
  <meta property="og:url" content="https://emora.app/">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="EMORA App">
  <meta name="twitter:description" content="AI companion with emotional memory.">
  <link rel="alternate" hreflang="en" href="https://emora.app/">
  <link rel="alternate" hreflang="ja" href="https://emora.app/ja/">
  <link rel="alternate" hreflang="ko" href="https://emora.app/ko/">
  <link rel="alternate" hreflang="zh-TW" href="https://emora.app/zh-tw/">
  <link rel="alternate" hreflang="x-default" href="https://emora.app/">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "EMORA",
    "description": "AI companion app with long-term emotional memory and multilingual support.",
    "sameAs": [
      "https://twitter.com/emora_app",
      "https://www.facebook.com/emora"
    ]
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "EMORA Companion",
    "description": "An AI companion that learns and grows with you."
  }
  </script>
  <style>.hidden { display: none; } body { font-family: sans-serif; }</style>
  <script>console.log('analytics');</script>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/features">Features</a>
    <a href="/pricing">Pricing</a>
    <a href="/about">About</a>
  </nav>

  <h1>Meet EMORA, Your AI Companion</h1>
  <h2>Why Choose EMORA?</h2>
  <h3>Long-term Emotional Memory</h3>
  <h3>Available in 14 Languages</h3>

  <p>EMORA is an AI companion app that truly remembers your conversations and grows with you.
  Whether you need someone to talk to late at night or want to improve your language skills,
  EMORA is here for you.</p>

  <h2>Key Features</h2>
  <ul>
    <li>Voice chat in your native language</li>
    <li>Emotion tracking and mood journaling</li>
    <li>Offline mode for private conversations</li>
  </ul>

  <footer>
    <p>&copy; 2025 EMORA Inc. All rights reserved.</p>
    <nav>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </nav>
  </footer>
</body>
</html>`;

// ---------------------------------------------------------------------------
// JS-shell fixture (SPA with minimal content)
// ---------------------------------------------------------------------------

const JS_SHELL_HTML = `<!DOCTYPE html>
<html>
<head>
  <title></title>
  <script src="/bundle.js"></script>
</head>
<body>
  <div id="app"></div>
  <script>window.__INITIAL_STATE__ = {};</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Large-body fixture for truncation test
// ---------------------------------------------------------------------------

function makeLargeHtml(charCount: number): string {
  const filler = "Lorem ipsum dolor sit amet. ".repeat(Math.ceil(charCount / 28));
  return `<!DOCTYPE html>
<html lang="en">
<head><title>Long Page</title></head>
<body><p>${filler}</p></body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractPage — fixture HTML", () => {
  let signals: ExtractedSignals;

  // Run extraction once; all tests below inspect the same result.
  signals = extractPage(FIXTURE_HTML);

  it("extracts the <title> text", () => {
    expect(signals.title).toBe("EMORA — Your AI Companion App");
  });

  it("extracts meta description", () => {
    expect(signals.metaDescription).toContain("EMORA");
    expect(signals.metaDescription).toContain("14 languages");
  });

  it("extracts og:* metadata", () => {
    expect(signals.ogMeta["title"]).toBe("EMORA - AI Companion");
    expect(signals.ogMeta["description"]).toContain("emotional memory");
    expect(signals.ogMeta["image"]).toContain("og-image.jpg");
    expect(signals.ogMeta["url"]).toBe("https://emora.app/");
  });

  it("extracts twitter:* metadata", () => {
    expect(signals.twitterMeta["card"]).toBe("summary_large_image");
    expect(signals.twitterMeta["title"]).toBe("EMORA App");
    expect(signals.twitterMeta["description"]).toContain("emotional memory");
  });

  it("extracts JSON-LD Organization entity", () => {
    const org = signals.jsonLd.find((e) => e.type === "Organization");
    expect(org).toBeDefined();
    expect(org?.name).toBe("EMORA");
    expect(org?.description).toContain("multilingual");
    expect(org?.sameAs).toContain("https://twitter.com/emora_app");
    expect(org?.sameAs).toContain("https://www.facebook.com/emora");
  });

  it("extracts JSON-LD Product entity", () => {
    const product = signals.jsonLd.find((e) => e.type === "Product");
    expect(product).toBeDefined();
    expect(product?.name).toBe("EMORA Companion");
    expect(product?.description).toContain("grows with you");
  });

  it("extracts h1, h2, h3 headings in order", () => {
    expect(signals.headings[0]).toContain("EMORA");
    expect(signals.headings).toContain("Why Choose EMORA?");
    expect(signals.headings).toContain("Long-term Emotional Memory");
    expect(signals.headings).toContain("Available in 14 Languages");
    expect(signals.headings).toContain("Key Features");
  });

  it("extracts nav link text", () => {
    expect(signals.navLinks).toContain("Home");
    expect(signals.navLinks).toContain("Features");
    expect(signals.navLinks).toContain("Pricing");
    expect(signals.navLinks).toContain("About");
  });

  it("extracts htmlLang from <html lang>", () => {
    expect(signals.htmlLang).toBe("en");
  });

  it("extracts hreflang entries", () => {
    expect(signals.hreflang.length).toBeGreaterThanOrEqual(4);

    const jaEntry = signals.hreflang.find((h) => h.lang === "ja");
    expect(jaEntry).toBeDefined();
    expect(jaEntry?.href).toBe("https://emora.app/ja/");

    const koEntry = signals.hreflang.find((h) => h.lang === "ko");
    expect(koEntry).toBeDefined();

    const zhEntry = signals.hreflang.find((h) => h.lang === "zh-TW");
    expect(zhEntry).toBeDefined();

    const xDefault = signals.hreflang.find((h) => h.lang === "x-default");
    expect(xDefault).toBeDefined();
  });

  it("bodyText does not contain script/style/nav/footer content", () => {
    // Script content from head
    expect(signals.bodyText).not.toContain("console.log");
    expect(signals.bodyText).not.toContain("analytics");
    // Style rule
    expect(signals.bodyText).not.toContain("display: none");
    // Footer copyright (stripped with footer tag)
    expect(signals.bodyText).not.toContain("All rights reserved");
  });

  it("bodyText contains meaningful page content", () => {
    expect(signals.bodyText).toContain("EMORA");
    // Nav is stripped but body paragraph is not
    expect(signals.bodyText).toContain("AI companion");
  });
});

// ---------------------------------------------------------------------------
// JS-shell / empty page — graceful degrade
// ---------------------------------------------------------------------------

describe("extractPage — JS-shell page (graceful degrade)", () => {
  it("returns empty-but-valid signals for a JS-shell page", () => {
    const signals = extractPage(JS_SHELL_HTML);

    // Should not throw; all fields must be valid types
    expect(typeof signals.title).toBe("string");
    expect(typeof signals.metaDescription).toBe("string");
    expect(typeof signals.htmlLang).toBe("string");
    expect(typeof signals.bodyText).toBe("string");
    expect(Array.isArray(signals.headings)).toBe(true);
    expect(Array.isArray(signals.navLinks)).toBe(true);
    expect(Array.isArray(signals.hreflang)).toBe(true);
    expect(Array.isArray(signals.jsonLd)).toBe(true);
    expect(signals.ogMeta).toBeTypeOf("object");
    expect(signals.twitterMeta).toBeTypeOf("object");

    // JS-shell has no meaningful content
    expect(signals.title).toBe("");
    expect(signals.hreflang).toHaveLength(0);
    expect(signals.jsonLd).toHaveLength(0);
    expect(signals.headings).toHaveLength(0);
  });

  it("returns empty-but-valid signals for completely empty string", () => {
    const signals = extractPage("");
    expect(signals.title).toBe("");
    expect(signals.hreflang).toHaveLength(0);
    expect(signals.bodyText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Truncation — bodyText must not exceed TEXT_CHAR_LIMIT
// ---------------------------------------------------------------------------

describe("extractPage — truncation", () => {
  it("truncates bodyText to ~7 K chars for a very long page", () => {
    const html = makeLargeHtml(50_000);
    const signals = extractPage(html);

    // 7 000 chars limit
    expect(signals.bodyText.length).toBeLessThanOrEqual(7_000);
    expect(signals.bodyText.length).toBeGreaterThan(0);
  });

  it("does not truncate short pages", () => {
    const shortHtml = `<html><head><title>Short</title></head><body><p>Hello world.</p></body></html>`;
    const signals = extractPage(shortHtml);
    expect(signals.bodyText).toContain("Hello world");
    expect(signals.bodyText.length).toBeLessThan(7_000);
  });
});

// ---------------------------------------------------------------------------
// JSON-LD edge cases
// ---------------------------------------------------------------------------

describe("extractPage — JSON-LD edge cases", () => {
  it("handles @graph arrays in JSON-LD", () => {
    const html = `<html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", "name": "Acme Corp", "sameAs": ["https://acme.com"] },
          { "@type": "Product", "name": "Acme Widget" }
        ]
      }
      </script>
    </head><body></body></html>`;
    const signals = extractPage(html);
    expect(signals.jsonLd.find((e) => e.type === "Organization")?.name).toBe("Acme Corp");
    expect(signals.jsonLd.find((e) => e.type === "Product")?.name).toBe("Acme Widget");
  });

  it("ignores malformed JSON-LD without throwing", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ INVALID JSON </script>
      <script type="application/ld+json">{ "@type": "Organization", "name": "Good Corp" }</script>
    </head><body></body></html>`;
    expect(() => extractPage(html)).not.toThrow();
    const signals = extractPage(html);
    // The valid block should still be extracted
    expect(signals.jsonLd.find((e) => e.name === "Good Corp")).toBeDefined();
  });

  it("ignores non-Organization/Product JSON-LD types", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ "@type": "WebPage", "name": "Home" }</script>
    </head><body></body></html>`;
    const signals = extractPage(html);
    expect(signals.jsonLd).toHaveLength(0);
  });

  it("handles sameAs as a single string (not array)", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ "@type": "Organization", "name": "X", "sameAs": "https://x.com" }</script>
    </head><body></body></html>`;
    const signals = extractPage(html);
    const org = signals.jsonLd.find((e) => e.type === "Organization");
    expect(org?.sameAs).toEqual(["https://x.com"]);
  });
});

// ---------------------------------------------------------------------------
// Meta description fallback
// ---------------------------------------------------------------------------

describe("extractPage — metaDescription fallback", () => {
  it("prefers <meta name=description> over og:description", () => {
    const html = `<html><head>
      <meta name="description" content="Named description">
      <meta property="og:description" content="OG description">
    </head><body></body></html>`;
    const signals = extractPage(html);
    expect(signals.metaDescription).toBe("Named description");
  });

  it("falls back to og:description when name=description is absent", () => {
    const html = `<html><head>
      <meta property="og:description" content="OG only description">
    </head><body></body></html>`;
    const signals = extractPage(html);
    expect(signals.metaDescription).toBe("OG only description");
  });
});
