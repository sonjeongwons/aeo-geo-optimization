/**
 * test/dedup-cjk.test.ts
 *
 * T11 dedup acceptance tests: CJK fixtures, cross-language non-collapse,
 * exact normalization, phrasing-variant preservation.
 *
 * Acceptance criteria verified:
 *  ✓ Collapses CJK restatements on emora ja/ko/zh fixtures
 *  ✓ Preserves genuine phrasing variants (distinct phrasingGroupId)
 *  ✓ Keeps en and ja phrasings of the same intent (no cross-language collapse)
 *  ✓ Exact normalization prevents UNIQUE collisions
 *  ✓ dedup-cjk.test.ts passes on non-space-delimited fixtures
 */

import { describe, it, expect } from "vitest";
import { dedup, normalizeText, trigramJaccard } from "../src/generate/dedup.js";
import type { DraftQuestion } from "../src/generate/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(
  text: string,
  language: string,
  phrasingGroupId: string,
  density_tier: "core" | "secondary" | "longtail" = "secondary",
  intentType: "brand" | "category" | "comparison" | "alternative" | "useCase" | "attribute" = "category",
  funnel_stage: string | null = "consideration"
): DraftQuestion {
  return { text, language, phrasingGroupId, density_tier, intentType, funnel_stage };
}

// ---------------------------------------------------------------------------
// Layer 1: normalizeText
// ---------------------------------------------------------------------------

describe("normalizeText", () => {
  it("lowercases ASCII text", () => {
    expect(normalizeText("Hello World")).toBe("hello world");
  });

  it("folds Latin diacritics cafe", () => {
    // e + combining acute accent (U+0301) should strip to plain e
    const withDiacritic = "café"; // precomposed NFC: U+00E9
    expect(normalizeText(withDiacritic)).toBe("cafe");
  });

  it("folds Latin diacritics uber", () => {
    const text = "Über die Zeit"; // Ü = U+00DC
    expect(normalizeText(text)).toBe("uber die zeit");
  });

  it("collapses whitespace", () => {
    expect(normalizeText("hello   world\ttab")).toBe("hello world tab");
  });

  it("strips trailing Latin question mark", () => {
    expect(normalizeText("What is EMORA?")).toBe("what is emora");
  });

  it("strips trailing Latin exclamation mark", () => {
    expect(normalizeText("Tell me about EMORA!")).toBe("tell me about emora");
  });

  it("strips trailing Latin period", () => {
    expect(normalizeText("Explain EMORA.")).toBe("explain emora");
  });

  it("strips trailing CJK full-stop (U+3002)", () => {
    // U+3002 = ideographic full stop
    const text = "EMORAについて教えてください。";
    const norm = normalizeText(text);
    expect(norm.endsWith("。")).toBe(false);
    expect(norm).toBe("emoraについて教えてください");
  });

  it("strips trailing CJK question mark (U+FF1F)", () => {
    // U+FF1F = fullwidth question mark
    const text = "EMORAを使うべきですか？";
    const norm = normalizeText(text);
    expect(norm.endsWith("？")).toBe(false);
  });

  it("NFC-normalizes so precomposed/decomposed are equivalent", () => {
    const precomposed = "café"; // U+00E9 NFC precomposed
    const decomposed = "café"; // e + combining acute (NFD)
    expect(normalizeText(precomposed)).toBe(normalizeText(decomposed));
  });

  it("preserves Japanese katakana with dakuten (does NOT strip as diacritic)", () => {
    // U+30D1 = PA (katakana), U+30D7 = PU (katakana)
    // These must NOT be reduced to HA (U+30CF) and FU (U+30D5)
    const text = "EMORAはコンパニオンアプリです";
    const norm = normalizeText(text);
    // Check that PA (U+30D1) is still PA, not HA (U+30CF)
    expect(norm).toContain("パ"); // PA must still be there
    // Check that PU (U+30D7) is still PU, not FU (U+30D5)
    expect(norm).toContain("プ"); // PU must still be there
    // And the full expected output
    expect(norm).toBe(
      "emoraはコンパニオンアプリです"
    );
  });

  it("lowercases ASCII in mixed Japanese-ASCII text", () => {
    // EMORA + Japanese kana + trailing question mark
    const text = "EMORAとは何ですか？";
    const norm = normalizeText(text);
    expect(norm.startsWith("emora")).toBe(true);
    // trailing fullwidth ? stripped
    expect(norm.endsWith("？")).toBe(false);
    expect(norm).toBe("emoraとは何ですか");
  });
});

// ---------------------------------------------------------------------------
// trigramJaccard
// ---------------------------------------------------------------------------

describe("trigramJaccard", () => {
  it("identical strings produce similarity 1", () => {
    expect(trigramJaccard("hello world", "hello world")).toBe(1);
  });

  it("completely different strings produce low similarity", () => {
    const sim = trigramJaccard("hello world", "xyz abc def");
    expect(sim).toBeLessThan(0.3);
  });

  it("high similarity for near-restatement in English", () => {
    const sim = trigramJaccard(
      "what is the best ai companion app",
      "what are the best ai companion apps"
    );
    expect(sim).toBeGreaterThan(0.65);
  });

  it("CJK trigrams work for strings differing by one character", () => {
    // Two Japanese strings that differ only in the last word
    // str1: emora + ha + AI + konpanion + apuri + desu
    // str2: emora + ha + AI + konpanion + apuri + da
    // All trigrams except the last 2-3 are shared
    const a = "emoraはコンパニオンアプリです";
    const b = "emoraはコンパニオンアプリだ";
    const sim = trigramJaccard(a, b);
    expect(sim).toBeGreaterThan(0.65);
  });

  it("genuinely different CJK questions produce lower similarity", () => {
    // pricing vs comparison question
    const a = "emoraの料金はいくらですか"; // pricing
    const b = "emoraと競合他社の違いは何ですか"; // comparison
    const sim = trigramJaccard(a, b);
    expect(sim).toBeLessThan(0.65);
  });

  it("short strings (< 3 codepoints) use exact match only", () => {
    expect(trigramJaccard("hi", "hi")).toBe(1);
    expect(trigramJaccard("hi", "ho")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 1 exact dedup
// ---------------------------------------------------------------------------

describe("dedup Layer 1 exact / normalized", () => {
  it("drops exact duplicate texts within the same language", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-1"),
      q("What is EMORA?", "en", "pg-2"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(kept[0]!.phrasingGroupId).toBe("pg-1");
  });

  it("drops normalized-equivalent duplicates (case + trailing punct)", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-1"),
      q("what is emora", "en", "pg-2"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it("drops diacritic-folded duplicates", () => {
    const qs = [
      q("café companion app", "fr", "pg-1"),
      q("cafe companion app", "fr", "pg-2"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it("keeps genuinely different texts", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-1"),
      q("How much does EMORA cost?", "en", "pg-2"),
      q("Who created EMORA?", "en", "pg-3"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(3);
  });

  it("CJK exact duplicate in Japanese collapses to one", () => {
    // Same Japanese text with fullwidth ? vs without (after normalization both are same)
    const text1 = "EMORAとは何ですか？"; // with ?
    const text2 = "EMORAとは何ですか"; // without ?
    const qs = [q(text1, "ja", "pg-1"), q(text2, "ja", "pg-2")];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it("Korean exact duplicate collapses", () => {
    const qs = [
      q("EMORA는 어떤 앱인가요?", "ko", "pg-1"),
      q("EMORA는 어떤 앱인가요?", "ko", "pg-2"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it("Chinese trailing punct deduped", () => {
    const qs = [
      q("EMORA是什么？", "zh", "pg-z1"),
      q("EMORA是什么", "zh", "pg-z2"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 near-dup (CJK fixtures from emora)
// ---------------------------------------------------------------------------

describe("dedup Layer 2 near-dup CJK fixtures", () => {
  // Use strings that differ by only 1-2 codepoints at the END, guaranteeing
  // high trigram Jaccard similarity (> 0.65 threshold).

  it("collapses Japanese near-restatements from the same phrasingGroupId", () => {
    // base: "emora ha konpanion apuri desu" (19 codepoints after normalize)
    // near-dup 1: replace last 2 chars "desu" with "da" (1 char shorter)
    // near-dup 2: add particle at end
    const base = "emoraはコンパニオンアプリです";
    const nd1  = "emoraはコンパニオンアプリだ";
    const nd2  = "emoraはコンパニオンアプリですね";
    // All same phrasingGroupId -> should collapse to just base
    const qs = [
      q(base, "ja", "pg-rep"),
      q(nd1,  "ja", "pg-rep"),
      q(nd2,  "ja", "pg-rep"),
    ];
    const { kept, dropped } = dedup(qs);
    // Representative kept; same-pgId near-dups dropped
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(2);
  });

  it("keeps Japanese variants from DIFFERENT phrasingGroupIds (genuine variants)", () => {
    const base = "emoraはコンパニオンアプリです";
    const var1 = "emoraはコンパニオンアプリだ";
    // Near-dup but different pgId -> sibling kept
    const qs = [
      q(base, "ja", "pg-1"),
      q(var1, "ja", "pg-2"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it("collapses Korean near-restatements from same phrasingGroupId", () => {
    // Korean: "emora nun eoneon aepida" vs with one char changed at end
    const base = "emora는 언어 리니스트 안내 앱입니다";
    const nd1  = "emora는 언어 리니스트 안내 앱이다";
    const qs = [
      q(base, "ko", "pg-k1"),
      q(nd1,  "ko", "pg-k1"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(1);
  });

  it("sibling cap: keeps at most MAX_SIBLINGS_PER_CLUSTER siblings per cluster", () => {
    // 1 rep + 5 near-dup siblings from 5 different pgIds
    // All share a very long common prefix, differing only in the last character
    const prefix = "emoraはコンパニオンアプリで";
    const rep = q(prefix + "す", "ja", "pg-rep");
    const siblings = [
      q(prefix + "すよ", "ja", "pg-s1"),
      q(prefix + "すね", "ja", "pg-s2"),
      q(prefix + "すわ", "ja", "pg-s3"),
      q(prefix + "すが", "ja", "pg-s4"),
      q(prefix + "すぞ", "ja", "pg-s5"),
    ];
    const { kept, dropped } = dedup([rep, ...siblings]);
    // Representative + at most 3 siblings = at most 4 kept
    expect(kept.length).toBeLessThanOrEqual(4);
    expect(kept[0]).toBe(rep);
    expect(dropped.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Cross-language: NO cross-language collapse
// ---------------------------------------------------------------------------

describe("dedup NO cross-language collapse", () => {
  it("keeps en and ja phrasings of the same intent separately", () => {
    const qs = [
      q("What is the best AI companion app?", "en", "pg-en-1"),
      // Japanese equivalent - different language, should NOT be deduped
      q("emoraはコンパニオンアプリです", "ja", "pg-ja-1"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it("keeps en and ko phrasings independently", () => {
    const qs = [
      q("How does EMORA compare to competitors?", "en", "pg-en-c"),
      q("EMORA는 경쟁사와 어떻게 비교되나요", "ko", "pg-ko-c"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(2);
  });

  it("deduplicates within each language independently, not across", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-en-1"),
      q("What is EMORA?", "en", "pg-en-1"), // exact dup in en
      q("EMORAとは何ですか", "ja", "pg-ja-1"),
      q("EMORAとは何ですか", "ja", "pg-ja-2"), // exact dup in ja
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(2);
    const langs = kept.map((k) => k.language).sort();
    expect(langs).toEqual(["en", "ja"]);
  });
});

// ---------------------------------------------------------------------------
// Stable ordering
// ---------------------------------------------------------------------------

describe("dedup stable ordering", () => {
  it("preserves input order for kept items", () => {
    const qs = [
      q("How much does EMORA cost?", "en", "pg-3"),
      q("What is EMORA?", "en", "pg-1"),
      q("Who made EMORA?", "en", "pg-2"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(3);
    expect(kept[0]!.phrasingGroupId).toBe("pg-3");
    expect(kept[1]!.phrasingGroupId).toBe("pg-1");
    expect(kept[2]!.phrasingGroupId).toBe("pg-2");
  });

  it("language order follows first-appearance in input", () => {
    const qs = [
      q("EMORAとは何ですか", "ja", "pg-ja"),
      q("What is EMORA?", "en", "pg-en"),
      q("EMORA는 무엇인가요", "ko", "pg-ko"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(3);
    expect(kept[0]!.language).toBe("ja");
    expect(kept[1]!.language).toBe("en");
    expect(kept[2]!.language).toBe("ko");
  });
});

// ---------------------------------------------------------------------------
// UNIQUE constraint safety
// ---------------------------------------------------------------------------

describe("dedup UNIQUE constraint safety", () => {
  it("normalization collapses texts differing only in case and punctuation", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-1"),
      q("WHAT IS EMORA!", "en", "pg-2"),
      q("what is emora.", "en", "pg-3"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(1);
  });

  it("Korean: text with and without trailing ? deduped to one", () => {
    const qs = [
      q("EMORA란 무엇입니까?", "ko", "pg-k1"),
      q("EMORA란 무엇입니까", "ko", "pg-k2"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(1);
  });

  it("Chinese: text with and without fullwidth ? deduped to one", () => {
    const qs = [
      q("EMORA是什么？", "zh", "pg-z1"),
      q("EMORA是什么", "zh", "pg-z2"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("dedup edge cases", () => {
  it("empty input returns empty result", () => {
    const { kept, dropped } = dedup([]);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it("single question always kept", () => {
    const qs = [q("What is EMORA?", "en", "pg-1")];
    const { kept, dropped } = dedup(qs);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("all different languages, all kept", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-1"),
      q("EMORAとは何ですか", "ja", "pg-1"),
      q("EMORA는 무엇인가요", "ko", "pg-1"),
      q("EMORA是什么", "zh", "pg-1"),
      q("Qu'est-ce que EMORA?", "fr", "pg-1"),
    ];
    const { kept } = dedup(qs);
    expect(kept).toHaveLength(5);
  });

  it("kept + dropped totals equal input length", () => {
    const qs = [
      q("What is EMORA?", "en", "pg-1"),
      q("What is EMORA?", "en", "pg-2"),
      q("How much does EMORA cost?", "en", "pg-3"),
      q("EMORAとは何ですか", "ja", "pg-4"),
      q("EMORAとは何ですか", "ja", "pg-5"),
    ];
    const { kept, dropped } = dedup(qs);
    expect(kept.length + dropped.length).toBe(qs.length);
  });
});
