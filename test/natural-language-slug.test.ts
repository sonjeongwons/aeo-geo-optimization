/** test/natural-language-slug.test.ts — SOTA sweep I: natural-language slugs. */
import { describe, it, expect } from "vitest";
import { naturalLanguageSlug } from "../src/deploy/connectors/ownedNet.js";

const AID = "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb";

describe("naturalLanguageSlug (SOTA sweep I)", () => {
  it("builds a keyword slug from a question + a uniqueness suffix", () => {
    const slug = naturalLanguageSlug("What is the best Character AI alternative?", AID);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("what-is-the-best-character-ai")).toBe(true);
    expect(slug.endsWith("-abcdef")).toBe(true); // assetId suffix
  });

  it("is deterministic for the same (text, assetId)", () => {
    const a = naturalLanguageSlug("EMORA memory feature deep dive", AID);
    const b = naturalLanguageSlug("EMORA memory feature deep dive", AID);
    expect(a).toBe(b);
  });

  it("caps the number of words (concise URLs)", () => {
    const slug = naturalLanguageSlug("one two three four five six seven eight nine", AID, 6);
    const base = slug.replace(/-[a-z0-9]{1,6}$/, "");
    expect(base.split("-").length).toBeLessThanOrEqual(6);
  });

  it("STRIPS urls / bare domains so a slug never embeds a domain from prose", () => {
    const slug = naturalLanguageSlug(
      "Visit https://customer-domain.com or www.evil.io for more info",
      "inject-url-test-0000",
    );
    expect(slug).not.toContain("customer-domain");
    expect(slug).not.toContain("evil");
    expect(slug).toContain("visit");
  });

  it("falls back to the assetId prefix when no Latin keywords remain", () => {
    // Pure Hangul strips to empty under [a-z0-9].
    const slug = naturalLanguageSlug("에모라 메모리 기능", AID);
    expect(slug).toBe("abcdef12");
  });

  it("handles null/empty text → id slug", () => {
    expect(naturalLanguageSlug(null, AID)).toBe("abcdef12");
    expect(naturalLanguageSlug("", AID)).toBe("abcdef12");
  });

  it("two pages starting with the same words get DISTINCT slugs (suffix)", () => {
    const a = naturalLanguageSlug("best ai companion app", "aaaaaaaa-1111");
    const b = naturalLanguageSlug("best ai companion app", "bbbbbbbb-2222");
    expect(a).not.toBe(b);
    expect(a.replace(/-[a-z0-9]+$/, "")).toBe(b.replace(/-[a-z0-9]+$/, ""));
  });
});
