/**
 * Surface v1-b pricing — flat USD-per-call rates for SERP and scrape surfaces.
 *
 * DESIGN-phase4.md T03 / SPEC.md §11 (cost):
 *   SERP calls are metered via the EXISTING `llm_call` ledger, recorded with
 *   purpose='generation' and the surface's synthetic modelId.  This file
 *   provides the flat-rate lookup so the SurfaceAdapter (T07) can compute `usd`
 *   for AdapterUsage without a DB round-trip — exactly like providers/pricing.ts
 *   does for token-based models.
 *
 * DESIGN invariants:
 *   - providers/pricing.ts is UNCHANGED.  This file is additive.
 *   - SERP surfaces (googleAio, naverAi) are billed per API search call.
 *     Current reference: Google Custom Search JSON API ~$5/1000 calls = $0.005/call.
 *     Naver Search API ~$0/call (free tier) but we record $0 for ledger completeness.
 *   - Scrape surfaces (copilot, metaAi, line, kakao) are disabled-by-default stubs.
 *     Their pricing is $0 until an RPA runner is configured (billing shifts to infra).
 *   - All values are STUBS / estimates.  Update here when real contracts are signed.
 *   - density tiering (§5.3) is applied upstream by the plan builder; this file
 *     provides per-call atomic costs only.
 *
 * Pure — no IO.
 */

import type { SurfaceId } from "./types.js";

// ---------------------------------------------------------------------------
// SurfacePriceRow
// ---------------------------------------------------------------------------

/**
 * Pricing metadata for a single v1-b surface.
 *
 * Fields:
 *   surfaceId      — the canonical SurfaceId (mirrors types.ts)
 *   usdPerCall     — flat USD cost per API/scrape call.
 *                    0.0 for disabled stubs (RPA infra cost tracked externally).
 *   billingNote    — human-readable note on the pricing basis (for ops/audit).
 *   isMeterEnabled — true = record in llm_call ledger; false = stub, skip ledger.
 */
export interface SurfacePriceRow {
  surfaceId: SurfaceId;
  usdPerCall: number;
  billingNote: string;
  isMeterEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Canonical surface price table
// ---------------------------------------------------------------------------

/**
 * Authoritative flat-rate price table for v1-b surfaces.
 *
 * SERP surfaces:
 *   googleAio  — Google Custom Search / Search Console API.
 *                Reference: $5 / 1 000 calls → $0.005 per call.
 *                (Free tier: 100 calls/day; paid beyond that.)
 *   naverAi    — Naver Search API (currently free tier).
 *                Recorded as $0.0 for ledger completeness; update when pricing changes.
 *
 * Scrape surfaces (RPA runner — disabled by default):
 *   copilot    — Microsoft Copilot scrape. RPA infra cost tracked externally.
 *   metaAi     — Meta AI scrape. RPA infra cost tracked externally.
 *   line       — Line AI scrape (JP/TW/TH markets). RPA infra cost tracked externally.
 *   kakao      — Kakao AI scrape (KR market). RPA infra cost tracked externally.
 *
 * When real contracts are signed or infra billing is wired, update usdPerCall
 * here AND re-seed the `surface` DB table (migration 0012).
 */
export const SURFACE_PRICE_TABLE: SurfacePriceRow[] = [
  // SERP surfaces — official API only (§12 compliance)
  {
    surfaceId: "googleAio",
    usdPerCall: 0.005,   // $5 / 1 000 calls (Google Custom Search JSON API)
    billingNote: "Google Custom Search JSON API — $5/1000 queries (paid tier)",
    isMeterEnabled: true,
  },
  {
    surfaceId: "naverAi",
    usdPerCall: 0.0,     // Naver Search API free tier; update when paid tier activated
    billingNote: "Naver Search API — free tier; $0 until paid quota activated",
    isMeterEnabled: true,
  },
  {
    surfaceId: "googleAiMode",
    usdPerCall: 0.0,     // no AI Mode SERP API/pricing yet — NOT_CONFIGURED stub
    billingNote: "Google AI Mode — no official SERP API yet; $0 stub, not metered until armed (W2)",
    isMeterEnabled: false,
  },

  // Scrape surfaces — RPA runner (disabled by default; infra cost tracked externally)
  {
    surfaceId: "copilot",
    usdPerCall: 0.0,
    billingNote: "RPA runner (Copilot scrape) — infra cost tracked externally; $0 stub",
    isMeterEnabled: false,
  },
  {
    surfaceId: "metaAi",
    usdPerCall: 0.0,
    billingNote: "RPA runner (Meta AI scrape) — infra cost tracked externally; $0 stub",
    isMeterEnabled: false,
  },
  {
    surfaceId: "line",
    usdPerCall: 0.0,
    billingNote: "RPA runner (Line AI scrape, JP/TW/TH) — infra cost tracked externally; $0 stub",
    isMeterEnabled: false,
  },
  {
    surfaceId: "kakao",
    usdPerCall: 0.0,
    billingNote: "RPA runner (Kakao AI scrape, KR) — infra cost tracked externally; $0 stub",
    isMeterEnabled: false,
  },
];

// ---------------------------------------------------------------------------
// Index + lookup helpers
// ---------------------------------------------------------------------------

const _surfacePriceIndex = new Map<SurfaceId, SurfacePriceRow>(
  SURFACE_PRICE_TABLE.map((row) => [row.surfaceId, row])
);

/**
 * Look up the price row for a surface by its SurfaceId.
 * Returns undefined if the surface is not in the table.
 */
export function getSurfacePriceRow(
  surfaceId: SurfaceId
): SurfacePriceRow | undefined {
  return _surfacePriceIndex.get(surfaceId);
}

/**
 * Return the flat USD cost for one SERP/scrape call on the given surface.
 *
 * This is the surface equivalent of `priceUsd()` from providers/pricing.ts,
 * but for flat-rate (non-token) surfaces.  The SurfaceAdapter (T07) calls this
 * to populate `AdapterUsage.usd` so the llm_call ledger records the cost.
 *
 * Returns 0.0 for unknown surfaces (safe default — same pattern as priceUsd()).
 *
 * @param surfaceId  The SurfaceId of the surface making the call.
 * @returns          USD cost for one call (>= 0).
 */
export function surfaceUsdPerCall(surfaceId: SurfaceId): number {
  return _surfacePriceIndex.get(surfaceId)?.usdPerCall ?? 0.0;
}

/**
 * Return true if this surface's calls should be recorded in the llm_call ledger.
 *
 * SERP surfaces are metered (isMeterEnabled=true).
 * Scrape/RPA surfaces are stubs (isMeterEnabled=false) until a runner is configured;
 * they are excluded from the ledger to avoid false $0 records cluttering cost reports.
 *
 * @param surfaceId  The SurfaceId to check.
 * @returns          true if calls should be written to llm_call.
 */
export function isSurfaceMeterEnabled(surfaceId: SurfaceId): boolean {
  return _surfacePriceIndex.get(surfaceId)?.isMeterEnabled ?? false;
}
