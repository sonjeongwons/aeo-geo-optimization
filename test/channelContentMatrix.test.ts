/**
 * test/channelContentMatrix.test.ts
 *
 * T05 — Channel-content matrix tests.
 *
 * Acceptance criteria from phase2-tasks.json T05:
 *   - channelContentMatrix marks jsonld_* legal only for owned_net
 *   - requiresDisclosure true for pr_wire/directory/web2/social
 *
 * Also tests:
 *   - comparison_table is not legal on social
 *   - PR-wire syndication fan-out descriptor is correct
 *   - legalChannelsForFormat and legalFormatsForChannel helpers
 *   - isPrWireSyndicationCopy logic
 */

import { describe, it, expect } from "vitest";
import {
  CHANNEL_CONTENT_MATRIX,
  isFormatLegalOnChannel,
  legalChannelsForFormat,
  legalFormatsForChannel,
  requiresDisclosure,
  isPrWireSyndicationCopy,
  PR_WIRE_SYNDICATION_OUTLETS,
} from "../src/content/channelContentMatrix.js";
import type { ChannelClass, ContentFormat } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// JSON-LD formats: only legal on owned_net
// ---------------------------------------------------------------------------

describe("JSON-LD formats (§6) — only legal on owned_net", () => {
  const jsonldFormats: ContentFormat[] = ["jsonld_org", "jsonld_faqpage", "jsonld_article"];
  const allChannels: ChannelClass[] = ["owned_net", "pr_wire", "directory", "web2", "social", "entity"];

  for (const fmt of jsonldFormats) {
    it(`${fmt} is legal on owned_net`, () => {
      expect(isFormatLegalOnChannel(fmt, "owned_net")).toBe(true);
    });

    for (const ch of allChannels.filter((c) => c !== "owned_net")) {
      it(`${fmt} is NOT legal on ${ch}`, () => {
        expect(isFormatLegalOnChannel(fmt, ch)).toBe(false);
      });
    }

    it(`legalChannelsForFormat(${fmt}) returns only ['owned_net']`, () => {
      const legal = legalChannelsForFormat(fmt);
      expect(legal).toEqual(["owned_net"]);
    });
  }
});

// ---------------------------------------------------------------------------
// comparison_table: not on social or entity
// ---------------------------------------------------------------------------

describe("comparison_table", () => {
  it("is legal on owned_net", () => {
    expect(isFormatLegalOnChannel("comparison_table", "owned_net")).toBe(true);
  });

  it("is legal on pr_wire", () => {
    expect(isFormatLegalOnChannel("comparison_table", "pr_wire")).toBe(true);
  });

  it("is legal on directory", () => {
    expect(isFormatLegalOnChannel("comparison_table", "directory")).toBe(true);
  });

  it("is legal on web2", () => {
    expect(isFormatLegalOnChannel("comparison_table", "web2")).toBe(true);
  });

  it("is NOT legal on social", () => {
    // Acceptance criterion: comparison not on social
    expect(isFormatLegalOnChannel("comparison_table", "social")).toBe(false);
  });

  it("is NOT legal on entity", () => {
    expect(isFormatLegalOnChannel("comparison_table", "entity")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// faq_table: not on social or entity
// ---------------------------------------------------------------------------

describe("faq_table", () => {
  it("is legal on owned_net, pr_wire, directory, web2", () => {
    expect(isFormatLegalOnChannel("faq_table", "owned_net")).toBe(true);
    expect(isFormatLegalOnChannel("faq_table", "pr_wire")).toBe(true);
    expect(isFormatLegalOnChannel("faq_table", "directory")).toBe(true);
    expect(isFormatLegalOnChannel("faq_table", "web2")).toBe(true);
  });

  it("is NOT legal on social", () => {
    expect(isFormatLegalOnChannel("faq_table", "social")).toBe(false);
  });

  it("is NOT legal on entity", () => {
    expect(isFormatLegalOnChannel("faq_table", "entity")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// definition_sentence: legal on all channels
// ---------------------------------------------------------------------------

describe("definition_sentence", () => {
  const allChannels: ChannelClass[] = ["owned_net", "pr_wire", "directory", "web2", "social", "entity"];

  for (const ch of allChannels) {
    it(`is legal on ${ch}`, () => {
      expect(isFormatLegalOnChannel("definition_sentence", ch)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// answer_block: legal on all channels
// ---------------------------------------------------------------------------

describe("answer_block format", () => {
  const allChannels: ChannelClass[] = ["owned_net", "pr_wire", "directory", "web2", "social", "entity"];

  for (const ch of allChannels) {
    it(`is legal on ${ch}`, () => {
      expect(isFormatLegalOnChannel("answer_block", ch)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// requiresDisclosure — §7#6
// ---------------------------------------------------------------------------

describe("requiresDisclosure (§7#6)", () => {
  it("returns true for pr_wire", () => {
    // Acceptance criterion: requiresDisclosure true for pr_wire
    expect(requiresDisclosure("pr_wire")).toBe(true);
  });

  it("returns true for directory", () => {
    // Acceptance criterion: requiresDisclosure true for directory
    expect(requiresDisclosure("directory")).toBe(true);
  });

  it("returns true for web2", () => {
    // Acceptance criterion: requiresDisclosure true for web2
    expect(requiresDisclosure("web2")).toBe(true);
  });

  it("returns true for social", () => {
    // Acceptance criterion: requiresDisclosure true for social
    expect(requiresDisclosure("social")).toBe(true);
  });

  it("returns false for owned_net", () => {
    expect(requiresDisclosure("owned_net")).toBe(false);
  });

  it("returns false for entity", () => {
    expect(requiresDisclosure("entity")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// legalFormatsForChannel helper
// ---------------------------------------------------------------------------

describe("legalFormatsForChannel", () => {
  it("owned_net includes all formats", () => {
    const formats = legalFormatsForChannel("owned_net");
    expect(formats).toContain("definition_sentence");
    expect(formats).toContain("answer_block");
    expect(formats).toContain("faq_table");
    expect(formats).toContain("comparison_table");
    expect(formats).toContain("case_study");
    expect(formats).toContain("jsonld_org");
    expect(formats).toContain("jsonld_faqpage");
    expect(formats).toContain("jsonld_article");
  });

  it("social excludes faq_table, comparison_table, and all jsonld_* formats", () => {
    const formats = legalFormatsForChannel("social");
    expect(formats).not.toContain("faq_table");
    expect(formats).not.toContain("comparison_table");
    expect(formats).not.toContain("jsonld_org");
    expect(formats).not.toContain("jsonld_faqpage");
    expect(formats).not.toContain("jsonld_article");
  });

  it("entity only includes definition_sentence and answer_block (no tabular or jsonld formats)", () => {
    const formats = legalFormatsForChannel("entity");
    expect(formats).toContain("definition_sentence");
    expect(formats).toContain("answer_block");
    expect(formats).not.toContain("faq_table");
    expect(formats).not.toContain("comparison_table");
    expect(formats).not.toContain("jsonld_org");
    expect(formats).not.toContain("jsonld_faqpage");
    expect(formats).not.toContain("jsonld_article");
  });
});

// ---------------------------------------------------------------------------
// PR-wire syndication fan-out descriptor
// ---------------------------------------------------------------------------

describe("PR_WIRE_SYNDICATION_OUTLETS", () => {
  it("is a non-empty array", () => {
    expect(PR_WIRE_SYNDICATION_OUTLETS.length).toBeGreaterThan(0);
  });

  it("each outlet has outlet_id, outlet_name, and auto_syndicated", () => {
    for (const outlet of PR_WIRE_SYNDICATION_OUTLETS) {
      expect(typeof outlet.outlet_id).toBe("string");
      expect(outlet.outlet_id.length).toBeGreaterThan(0);
      expect(typeof outlet.outlet_name).toBe("string");
      expect(outlet.outlet_name.length).toBeGreaterThan(0);
      expect(typeof outlet.auto_syndicated).toBe("boolean");
    }
  });

  it("outlet_ids are unique", () => {
    const ids = PR_WIRE_SYNDICATION_OUTLETS.map((o) => o.outlet_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe("isPrWireSyndicationCopy", () => {
  it("returns true for pr_wire vs pr_wire with same phrasing_group_id (intentional fan-out)", () => {
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-abc", "pr_wire")).toBe(true);
  });

  it("returns true for pr_wire with same phrasing_group_id when sibling_channel_class defaults to pr_wire", () => {
    // backward-compat: 3-arg call still exempts pr_wire-to-pr_wire pairs
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-abc")).toBe(true);
  });

  it("returns false for pr_wire with different phrasing_group_id (genuine dup candidate)", () => {
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-xyz", "pr_wire")).toBe(false);
  });

  it("returns false for non-pr_wire candidate channels even with same phrasing_group_id", () => {
    expect(isPrWireSyndicationCopy("owned_net", "pgid-abc", "pgid-abc", "pr_wire")).toBe(false);
    expect(isPrWireSyndicationCopy("social", "pgid-abc", "pgid-abc", "pr_wire")).toBe(false);
    expect(isPrWireSyndicationCopy("web2", "pgid-abc", "pgid-abc", "pr_wire")).toBe(false);
  });

  // GB-05 regression: pr_wire candidate vs non-pr_wire sibling sharing
  // phrasing_group_id must be FLAGGED (not exempted) — §7#1 cross-channel
  // boilerplate duplication check.
  it("GB-05 — returns false (not exempted) for pr_wire vs owned_net with same phrasing_group_id", () => {
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-abc", "owned_net")).toBe(false);
  });

  it("GB-05 — returns false (not exempted) for pr_wire vs web2 with same phrasing_group_id", () => {
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-abc", "web2")).toBe(false);
  });

  it("GB-05 — returns false (not exempted) for pr_wire vs directory with same phrasing_group_id", () => {
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-abc", "directory")).toBe(false);
  });

  it("GB-05 — returns false (not exempted) for pr_wire vs social with same phrasing_group_id", () => {
    expect(isPrWireSyndicationCopy("pr_wire", "pgid-abc", "pgid-abc", "social")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Matrix exhaustiveness — all formats have an entry for every channel_class
// ---------------------------------------------------------------------------

describe("CHANNEL_CONTENT_MATRIX exhaustiveness", () => {
  const allFormats: ContentFormat[] = [
    "definition_sentence",
    "answer_block",
    "faq_table",
    "comparison_table",
    "case_study",
    "jsonld_org",
    "jsonld_faqpage",
    "jsonld_article",
  ];
  const allChannels: ChannelClass[] = [
    "owned_net",
    "pr_wire",
    "directory",
    "web2",
    "social",
    "entity",
  ];

  for (const fmt of allFormats) {
    for (const ch of allChannels) {
      it(`${fmt} × ${ch} has an explicit entry`, () => {
        const row = CHANNEL_CONTENT_MATRIX[fmt];
        expect(row).toBeDefined();
        const entry = row[ch];
        expect(entry).toBeDefined();
        expect(typeof entry!.legal).toBe("boolean");
      });
    }
  }
});
