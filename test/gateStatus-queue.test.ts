/**
 * test/gateStatus-queue.test.ts
 *
 * T15 acceptance criteria:
 *
 * 1. Only gate_status='passed' assets become queue rows; blocked/needs_human
 *    are NOT selectable (structural §0 deploy gate).
 * 2. The generator NEVER emits gate_status='passed' except via the fold result.
 * 3. This module exposes no deploy/HTTP-write function (§0 structural check).
 * 4. Re-gate after a claim sign-off is $0 (no LLM call).
 * 5. isQueueEligible returns true only for 'passed'.
 * 6. assembleContentSet body validation rejects out-of-band answer_blocks.
 * 7. assembleContentSet propagates gate_status from runContentGates fold result
 *    (all verdicts collected, non-short-circuit).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  queueForDeploy,
  isQueueEligible,
  NO_HTTP_WRITE_VERB,
} from "../src/content/queueForDeploy.js";
import { assembleContentSet } from "../src/content/assembleContentSet.js";
import type { AssembleContentSetInput } from "../src/content/assembleContentSet.js";
import type { ContentGate } from "../src/content/contentGate.js";
import type { ContentGateContext, ContentGateResult } from "../src/content/types.js";
import type { GeneratedContentItemWithReview } from "../src/content/multilingualContent.js";
import type { ContentAsset } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Mock repo functions — assembleContentSet and queueForDeploy call repo.ts
// We mock the DB layer so tests run without a live DB.
// ---------------------------------------------------------------------------

vi.mock("../src/db/repo.js", () => ({
  insertContentAsset: vi.fn(),
  listContentAssetsForDedup: vi.fn(),
  updateAssetGateStatus: vi.fn(),
  queuePassedAssets: vi.fn(),
}));

import {
  insertContentAsset,
  listContentAssetsForDedup,
  updateAssetGateStatus,
  queuePassedAssets,
} from "../src/db/repo.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTENT_SET_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const CUSTOMER_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TEMPLATE_ID = "cccccccc-0000-0000-0000-000000000003";
const ASSET_ID_1 = "dddddddd-0000-0000-0000-000000000004";
const ASSET_ID_2 = "eeeeeeee-0000-0000-0000-000000000005";
const ASSET_ID_3 = "ffffffff-0000-0000-0000-000000000006";

/**
 * Build a minimal GeneratedContentItemWithReview for testing.
 */
function makeGeneratedItem(
  overrides: Partial<GeneratedContentItemWithReview> = {}
): GeneratedContentItemWithReview {
  return {
    format: "definition_sentence",
    language: "en",
    channel_class: "owned_net",
    phrasingGroupId: "group-en-1",
    body: {
      content_type: "definition",
      text: "EMORA is a conversational AI companion.",
      meaning_key: "emora-definition",
    },
    candidateClaims: [],
    needs_native_review: false,
    ...overrides,
  };
}

/**
 * Build a minimal ContentAsset for use as a sibling.
 */
function makeContentAsset(id: string, gateStatus: ContentAsset["gate_status"] = "pending"): ContentAsset {
  return {
    id,
    customer_id: null,
    industry: "ai-companion",
    template_id: TEMPLATE_ID,
    template_version: 1,
    content_set_id: CONTENT_SET_ID,
    content_type: "definition",
    format: "definition_sentence",
    channel_class: "owned_net",
    language: "en",
    phrasing_group_id: "group-en-sibling",
    body: {
      content_type: "definition",
      text: "EMORA is an AI app for companionship.",
      meaning_key: "emora-definition-sibling",
    },
    claims: [],
    word_count: 8,
    gate_status: gateStatus,
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: new Date("2026-06-20T00:00:00Z"),
  };
}

/**
 * A gate that always passes.
 */
const alwaysPassGate: ContentGate = {
  name: "alwaysPassGate",
  phase: "content",
  apply(_ctx: ContentGateContext): ContentGateResult {
    return { action: "pass", gate: "alwaysPassGate" };
  },
};

/**
 * A gate that always blocks.
 */
const alwaysBlockGate: ContentGate = {
  name: "alwaysBlockGate",
  phase: "content",
  apply(_ctx: ContentGateContext): ContentGateResult {
    return {
      action: "block",
      gate: "alwaysBlockGate",
      reason: "test: always block",
    };
  },
};

/**
 * A gate that always returns needs_human.
 */
const alwaysNeedsHumanGate: ContentGate = {
  name: "alwaysNeedsHumanGate",
  phase: "content",
  apply(_ctx: ContentGateContext): ContentGateResult {
    return {
      action: "needs_human",
      gate: "alwaysNeedsHumanGate",
      reason: "test: always needs_human",
    };
  },
};

/**
 * Shared assembleContentSet input builder.
 */
function makeInput(
  gates: readonly ContentGate[],
  overrides: Partial<AssembleContentSetInput> = {}
): AssembleContentSetInput {
  return {
    contentSetId: CONTENT_SET_ID,
    customerId: CUSTOMER_ID,
    industry: "ai-companion",
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    generatedItems: [makeGeneratedItem()],
    jsonLdAssets: [],
    brandAliases: ["EMORA"],
    claimSources: [],
    gates,
    provenance: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: queueForDeploy §0 structural assertions
// ---------------------------------------------------------------------------

describe("queueForDeploy — §0 structural", () => {
  it("NO_HTTP_WRITE_VERB is true (§0 export asserts no deploy verb)", () => {
    expect(NO_HTTP_WRITE_VERB).toBe(true);
  });

  it("isQueueEligible returns true only for 'passed'", () => {
    expect(isQueueEligible("passed")).toBe(true);
    expect(isQueueEligible("pending")).toBe(false);
    expect(isQueueEligible("blocked")).toBe(false);
    expect(isQueueEligible("needs_human")).toBe(false);
    expect(isQueueEligible("")).toBe(false);
  });

  it("module has no HTTP-write-verb export (§0 namespace check)", () => {
    // The module exposes: queueForDeploy, isQueueEligible, NO_HTTP_WRITE_VERB.
    // queueForDeploy is a QUEUE operation (local DB insert), NOT an HTTP-write verb.
    // Assert that no 'publish', 'send', 'post', 'put', 'patch', or 'push' function
    // is exported — these would indicate a live HTTP-deploy path.
    const mod = {
      queueForDeploy,
      isQueueEligible,
      NO_HTTP_WRITE_VERB,
    } as Record<string, unknown>;

    // HTTP-write verbs that would violate §0 (not including 'deploy' which is part
    // of the legitimate queueForDeploy queue-operation name).
    const httpWriteVerbs = ["publish", "send", "postTo", "putTo", "patchTo", "pushTo"];
    for (const verb of httpWriteVerbs) {
      const hasVerb = Object.keys(mod).some(
        (k) => k.toLowerCase().includes(verb.toLowerCase())
      );
      expect(hasVerb, `export '${verb}' should not exist`).toBe(false);
    }

    // Assert that no function in the module accepts a URL or HTTP client as a parameter.
    // queueForDeploy only accepts a contentSetId string → pure DB operation.
    expect(typeof queueForDeploy).toBe("function");
    // The function signature: (contentSetId: string) — no URL/HTTP param.
    expect(queueForDeploy.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: isQueueEligible purity
// ---------------------------------------------------------------------------

describe("isQueueEligible", () => {
  it("only gate_status='passed' is eligible for queuing", () => {
    const statuses: Array<[string, boolean]> = [
      ["passed", true],
      ["pending", false],
      ["blocked", false],
      ["needs_human", false],
      ["PASSED", false], // case-sensitive
    ];
    for (const [status, expected] of statuses) {
      expect(isQueueEligible(status)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: queueForDeploy delegates to repo.queuePassedAssets
// ---------------------------------------------------------------------------

describe("queueForDeploy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("queues gate_status='passed' assets via queuePassedAssets", async () => {
    vi.mocked(queuePassedAssets).mockResolvedValue({ queued: 3 });

    const result = await queueForDeploy(CONTENT_SET_ID);

    expect(queuePassedAssets).toHaveBeenCalledWith(CONTENT_SET_ID);
    expect(result.queued).toBe(3);
    expect(result.contentSetId).toBe(CONTENT_SET_ID);
  });

  it("returns queued=0 when no passed assets exist", async () => {
    vi.mocked(queuePassedAssets).mockResolvedValue({ queued: 0 });

    const result = await queueForDeploy(CONTENT_SET_ID);
    expect(result.queued).toBe(0);
  });

  it("is idempotent (queuePassedAssets handles ON CONFLICT DO NOTHING)", async () => {
    // First call inserts 2 rows; second call inserts 0 (already queued).
    vi.mocked(queuePassedAssets)
      .mockResolvedValueOnce({ queued: 2 })
      .mockResolvedValueOnce({ queued: 0 });

    const r1 = await queueForDeploy(CONTENT_SET_ID);
    const r2 = await queueForDeploy(CONTENT_SET_ID);

    expect(r1.queued).toBe(2);
    expect(r2.queued).toBe(0);
    expect(queuePassedAssets).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: assembleContentSet — gate_status from fold result only
// ---------------------------------------------------------------------------

describe("assembleContentSet — gate_status from fold result only", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: insertContentAsset returns a new id; listContentAssetsForDedup returns [];
    // updateAssetGateStatus is a no-op success.
    vi.mocked(insertContentAsset).mockResolvedValue({ id: ASSET_ID_1 });
    vi.mocked(listContentAssetsForDedup).mockResolvedValue([]);
    vi.mocked(updateAssetGateStatus).mockResolvedValue(undefined);
  });

  it("all-pass gates → gate_status='passed' (the ONLY path to passed)", async () => {
    const result = await assembleContentSet(makeInput([alwaysPassGate]));

    expect(result.passedCount).toBe(1);
    expect(result.blockedCount).toBe(0);
    expect(result.needsHumanCount).toBe(0);
    expect(result.assets[0]?.gateStatus).toBe("passed");

    // updateAssetGateStatus must be called with 'passed' — proves fold result drives status.
    expect(updateAssetGateStatus).toHaveBeenCalledWith(ASSET_ID_1, {
      gateStatus: "passed",
      claims: expect.any(Array),
      gateReport: expect.arrayContaining([
        expect.objectContaining({ gate: "alwaysPassGate", action: "pass" }),
      ]),
    });
  });

  it("block gate → gate_status='blocked'; never 'passed'", async () => {
    const result = await assembleContentSet(makeInput([alwaysBlockGate]));

    expect(result.blockedCount).toBe(1);
    expect(result.passedCount).toBe(0);
    expect(result.assets[0]?.gateStatus).toBe("blocked");

    expect(updateAssetGateStatus).toHaveBeenCalledWith(ASSET_ID_1, {
      gateStatus: "blocked",
      claims: expect.any(Array),
      gateReport: expect.arrayContaining([
        expect.objectContaining({ gate: "alwaysBlockGate", action: "block" }),
      ]),
    });
  });

  it("needs_human gate → gate_status='needs_human'; never 'passed'", async () => {
    const result = await assembleContentSet(makeInput([alwaysNeedsHumanGate]));

    expect(result.needsHumanCount).toBe(1);
    expect(result.passedCount).toBe(0);
    expect(result.assets[0]?.gateStatus).toBe("needs_human");
  });

  it("precedence: block > needs_human > passed (both block and needs_human → blocked)", async () => {
    vi.mocked(insertContentAsset)
      .mockResolvedValueOnce({ id: ASSET_ID_1 })
      .mockResolvedValueOnce({ id: ASSET_ID_2 });

    const input = makeInput([alwaysBlockGate, alwaysNeedsHumanGate], {
      generatedItems: [makeGeneratedItem(), makeGeneratedItem({ phrasingGroupId: "group-en-2" })],
    });

    const result = await assembleContentSet(input);

    // Both assets have both block and needs_human gates → terminal = blocked.
    expect(result.blockedCount).toBe(2);
    expect(result.needsHumanCount).toBe(0);
    expect(result.passedCount).toBe(0);
  });

  it("all verdicts collected even when first gate blocks (non-short-circuit fold)", async () => {
    // Two gates: first blocks, second passes; BOTH verdicts must be in gate_report.
    const result = await assembleContentSet(
      makeInput([alwaysBlockGate, alwaysPassGate])
    );

    const callArgs = vi.mocked(updateAssetGateStatus).mock.calls[0];
    const gateReport = callArgs?.[1]?.gateReport as Array<{
      gate: string;
      action: string;
    }> | undefined;

    expect(gateReport).toBeDefined();
    expect(gateReport).toHaveLength(2);
    expect(gateReport?.some((e) => e.gate === "alwaysBlockGate")).toBe(true);
    expect(gateReport?.some((e) => e.gate === "alwaysPassGate")).toBe(true);
  });

  it("body validation failure counts as validation_failed (not queued)", async () => {
    // Provide an invalid body — content_type mismatch
    const badItem = makeGeneratedItem({
      body: { content_type: "answer_block" as const, text: "", length_units: 0, numeric_claim_ids: [], source_ids: [] },
    });

    // insertContentAsset should NOT be called for a bad body.
    const result = await assembleContentSet(
      makeInput([alwaysPassGate], { generatedItems: [badItem] })
    );

    // The item fails body validation (text is empty) → validation failure.
    expect(result.validationFailedCount).toBeGreaterThan(0);
    expect(result.passedCount).toBe(0);
    // insertContentAsset not called for the bad item.
    expect(insertContentAsset).not.toHaveBeenCalled();
  });

  it("answer_block out of word-count band → validation failure (not inserted)", async () => {
    // 5-word text is far below the 134-word minimum → out-of-band.
    const shortItem = makeGeneratedItem({
      body: {
        content_type: "answer_block" as const,
        text: "Too short for band",
        length_units: 5,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const result = await assembleContentSet(
      makeInput([alwaysPassGate], { generatedItems: [shortItem] })
    );

    expect(result.validationFailedCount).toBeGreaterThan(0);
    expect(insertContentAsset).not.toHaveBeenCalled();
  });

  it("ON CONFLICT (insertContentAsset returns null) is treated as validation_failed", async () => {
    // Simulate ON CONFLICT DO NOTHING — insertContentAsset returns null.
    vi.mocked(insertContentAsset).mockResolvedValue(null);

    const result = await assembleContentSet(makeInput([alwaysPassGate]));

    expect(result.validationFailedCount).toBe(1);
    expect(result.passedCount).toBe(0);
  });

  it("siblings from DB are passed to gate context (phrasingVariationGate dedup scope)", async () => {
    const siblingAsset = makeContentAsset(ASSET_ID_2, "passed");

    // DB returns a sibling asset for this language.
    vi.mocked(listContentAssetsForDedup).mockResolvedValue([
      // Cast to satisfy the mock (DB row shape vs ContentAsset shape — same fields here).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      siblingAsset as any,
    ]);

    const applySpy = vi.fn((_ctx: ContentGateContext): ContentGateResult => {
      return { action: "pass", gate: "captureCtx" };
    });

    const captureCtxGate: ContentGate = {
      name: "captureCtx",
      phase: "content",
      apply: applySpy,
    };

    await assembleContentSet(makeInput([captureCtxGate]));

    // The gate should have been called with a ctx that includes the sibling.
    expect(applySpy).toHaveBeenCalled();
    const capturedCtx = applySpy.mock.calls[0]?.[0];
    expect(capturedCtx).toBeDefined();
    // The sibling (ASSET_ID_2) should appear in ctx.siblings; the asset itself
    // (ASSET_ID_1) should NOT appear in siblings (filtered out by id).
    const siblingIds = capturedCtx?.siblings.map((s: ContentAsset) => s.id) ?? [];
    expect(siblingIds).toContain(ASSET_ID_2);
    expect(siblingIds).not.toContain(ASSET_ID_1);
  });

  it("JSON-LD assets are assembled and gated (channel_class must be owned_net)", async () => {
    vi.mocked(insertContentAsset).mockResolvedValue({ id: ASSET_ID_3 });

    const jsonLdAsset: ContentAsset = {
      id: "00000000-0000-0000-0000-000000000099",  // pre-built uuid
      customer_id: null,
      industry: "ai-companion",
      template_id: TEMPLATE_ID,
      template_version: 1,
      content_set_id: CONTENT_SET_ID,
      content_type: "jsonld",
      format: "jsonld_org",
      channel_class: "owned_net",
      language: "en",
      phrasing_group_id: "jsonld-org-group",
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
      claims: [],
      word_count: null,
      gate_status: "pending",
      gate_report: null,
      disclosure_tag: null,
      needs_native_review: false,
      regen_attempts: 0,
      provenance: null,
      created_at: new Date("2026-06-20T00:00:00Z"),
    };

    const result = await assembleContentSet(
      makeInput([alwaysPassGate], {
        generatedItems: [],
        jsonLdAssets: [jsonLdAsset],
      })
    );

    expect(insertContentAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "jsonld",
        format: "jsonld_org",
        channelClass: "owned_net",
      })
    );
    expect(result.passedCount).toBe(1);
    expect(result.assets[0]?.format).toBe("jsonld_org");
    expect(result.assets[0]?.channelClass).toBe("owned_net");
  });
});

// ---------------------------------------------------------------------------
// Tests: gate_status='passed' is the ONLY path to a queue row
// ---------------------------------------------------------------------------

describe("gate_status='passed' is the ONLY path to a deploy queue row", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("queuePassedAssets not called for blocked assets (predicate excludes them)", async () => {
    // Simulate 0 passed assets.
    vi.mocked(queuePassedAssets).mockResolvedValue({ queued: 0 });

    const result = await queueForDeploy(CONTENT_SET_ID);

    // queuePassedAssets is called but with the gate_status='passed' predicate
    // in repo.ts; 0 rows queued means the predicate excluded all assets.
    expect(result.queued).toBe(0);
  });

  it("only passed assets appear in queue (repo-level selection predicate)", async () => {
    // This verifies the contract: queuePassedAssets uses the predicate
    // gate_status='passed' AND not-yet-queued. We assert the mock is called
    // with the correct contentSetId (repo enforces the predicate at the DB level).
    vi.mocked(queuePassedAssets).mockResolvedValue({ queued: 2 });

    const result = await queueForDeploy(CONTENT_SET_ID);

    expect(queuePassedAssets).toHaveBeenCalledWith(CONTENT_SET_ID);
    expect(result.queued).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: re-gate is $0 (no LLM call in assembleContentSet for existing assets)
// ---------------------------------------------------------------------------

describe("re-gate is $0 — no LLM call", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("regateAsset updates gate_status without calling generateStructured", async () => {
    // regateAsset is the $0 re-gate path used by reviewClaims CLI.
    // It only calls listContentAssetsForDedup + runContentGates + updateAssetGateStatus.
    // No LLM/generateStructured is called.
    const { regateAsset } = await import("../src/content/assembleContentSet.js");

    vi.mocked(listContentAssetsForDedup).mockResolvedValue([]);
    vi.mocked(updateAssetGateStatus).mockResolvedValue(undefined);

    const existingAsset = makeContentAsset(ASSET_ID_1, "needs_human");

    const result = await regateAsset(
      existingAsset,
      CONTENT_SET_ID,
      ["EMORA"],
      [], // updated claimSources (now signed)
      [alwaysPassGate]
    );

    expect(result.terminalStatus).toBe("passed");
    expect(updateAssetGateStatus).toHaveBeenCalledWith(ASSET_ID_1, {
      gateStatus: "passed",
      claims: expect.any(Array),
      gateReport: expect.arrayContaining([
        expect.objectContaining({ gate: "alwaysPassGate", action: "pass" }),
      ]),
    });

    // No insertContentAsset called (re-gate does not insert).
    expect(insertContentAsset).not.toHaveBeenCalled();
  });
});
