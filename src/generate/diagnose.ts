/**
 * src/generate/diagnose.ts
 *
 * URL diagnosis orchestrator (T07 / Phase 1).
 *
 * Pipeline (DESIGN-phase1.md §"URL Diagnosis"):
 *   FETCH  → EXTRACT → ONE Gemini structured call → BrandBrief
 *
 * Resilience:
 *   - If fetch fails (timeout, SSRF block, HTTP error, SPA shell), degrades
 *     gracefully to an industry-only BrandBrief and logs the reason.
 *   - Never throws to the caller; always resolves with DiagnoseResult.
 *
 * Cost ledger:
 *   - Every structured Gemini call is recorded via insertLlmCall
 *     (purpose='generation', run_id=null, customer_id=null for pre-customer
 *     URL-first diagnosis).
 *   - The ledger port (LedgerPort) is injected so tests can stub it.
 *
 * Off-site §0 compliance:
 *   - This module only reads (GET) the URL via urlFetch.ts — no mutations.
 *   - No competitor URLs are fetched (competitors inferred from LLM knowledge).
 *
 * DESIGN invariants:
 *   - Exactly ONE adapter.generateStructured() call on the happy path.
 *   - Exactly ZERO calls when the adapter returns NOT_CONFIGURED.
 *   - The returned BrandBrief is always validated by BrandBriefSchema.
 */

import { urlFetch } from "./urlFetch.js";
import { extractPage } from "./extractPage.js";
import { buildDiagnosePrompt } from "./diagnosePrompt.js";
import { BrandBriefSchema, type BrandBrief } from "./types.js";
import type { GenerateStructuredRequest, GenerateStructuredResult } from "../providers/types.js";
import { NOT_CONFIGURED } from "../providers/types.js";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Adapter port (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of GeminiAdapter that diagnose.ts needs.
 * Only generateStructured() is required — no generate() or judge().
 */
export interface DiagnoseAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>>;
}

// ---------------------------------------------------------------------------
// Ledger port (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Port for writing llm_call ledger rows.
 * In production this is insertLlmCall from repo.ts.
 * In tests it may be a no-op stub.
 */
export interface LedgerPort {
  insertLlmCall(c: {
    customerId: string | null;
    runId: string | null;
    purpose: "generation" | "judge";
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    usd: number;
    cacheHit: boolean;
    responseRawId: string | null;
  }): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DiagnoseOk {
  ok: true;
  brief: BrandBrief;
  /**
   * 'full' when the URL was fetched + extracted + inferred by Gemini.
   * 'industry-only' when the URL fetch/extract failed or the adapter
   *   was not configured; brief was assembled from the industry hint alone.
   */
  mode: "full" | "industry-only";
  /** Non-empty when the page was fetched but robots/noai directives noted. */
  robotsNote?: string;
  /** Non-empty when fetch/extraction failed — explains why we degraded. */
  degradeReason?: string;
}

export interface DiagnoseNotConfigured {
  ok: false;
  code: "NOT_CONFIGURED";
  message: string;
}

export interface DiagnoseError {
  ok: false;
  code: string;
  message: string;
}

export type DiagnoseResult = DiagnoseOk | DiagnoseNotConfigured | DiagnoseError;

// ---------------------------------------------------------------------------
// Default model for diagnosis
// ---------------------------------------------------------------------------

const DIAGNOSE_MODEL = "gemini-2.5-flash";
const DIAGNOSE_TEMPERATURE = 0.2;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full URL-diagnosis pipeline.
 *
 * @param opts.url        - The customer URL to diagnose (must be http/https).
 *                          If omitted, goes straight to industry-only mode.
 * @param opts.industry   - Optional industry key hint (e.g. "ai-companion").
 *                          Seeded into the prompt; used as fallback industryKey.
 * @param opts.customerId - Optional customer UUID for ledger attribution.
 * @param opts.modelId    - Optional Gemini model override (default: gemini-2.5-flash).
 * @param opts.adapter    - DiagnoseAdapter (GeminiAdapter with generateStructured).
 * @param opts.ledger     - LedgerPort for recording llm_call rows.
 * @returns DiagnoseResult — never throws.
 */
export async function diagnose(opts: {
  url?: string;
  industry?: string;
  customerId?: string | null;
  modelId?: string;
  adapter: DiagnoseAdapter;
  ledger: LedgerPort;
}): Promise<DiagnoseResult> {
  const { url, industry, customerId = null, adapter, ledger } = opts;
  const modelId = opts.modelId ?? DIAGNOSE_MODEL;

  // ---- Step 1: Fetch (skip when no URL supplied) ---------------------------
  let htmlContent: string | null = null;
  let degradeReason: string | undefined;
  let robotsNote: string | undefined;

  if (url) {
    const fetchResult = await urlFetch(url);
    if (fetchResult.ok) {
      htmlContent = fetchResult.html;
      if (fetchResult.robotsNote) {
        robotsNote = fetchResult.robotsNote;
      }
    } else {
      degradeReason = `URL fetch failed: ${fetchResult.reason}`;
      console.warn(`[diagnose] Degrading to industry-only — ${degradeReason}`);
    }
  } else {
    degradeReason = "No URL supplied; using industry-only mode.";
    if (industry) {
      console.info(`[diagnose] No URL; inferring industry-only brief for "${industry}".`);
    }
  }

  // ---- Step 2: Extract (skip when no HTML) --------------------------------
  const signals = htmlContent !== null ? extractPage(htmlContent) : null;

  // Detect "SPA shell" — body is too sparse to be useful
  const isSpaShell =
    signals !== null &&
    !signals.title &&
    !signals.metaDescription &&
    signals.bodyText.length < 100 &&
    signals.headings.length === 0;

  if (isSpaShell && !degradeReason) {
    degradeReason = "Page appears to be a JavaScript shell with no extractable content.";
    console.warn(`[diagnose] SPA shell detected for ${url ?? "(no url)"}; degrading.`);
  }

  // Use extracted signals when available and not spa-shell
  const effectiveSignals = signals !== null && !isSpaShell ? signals : null;

  // ---- Step 3: Build prompt + structured call ------------------------------
  // We always attempt the Gemini call even in degraded/industry-only mode,
  // because the LLM can still produce a useful brief from the industry hint.
  // However, if NEITHER a URL nor an industry was supplied, we cannot produce a
  // meaningful brief.
  if (!url && !industry) {
    return {
      ok: false,
      code: "INSUFFICIENT_INPUT",
      message: "diagnose() requires at least a URL or an industry hint.",
    };
  }

  // Import the empty-signals constructor (inline so the module stays pure)
  const fallbackSignals: Parameters<typeof buildDiagnosePrompt>[0] = effectiveSignals ?? {
    title: "",
    metaDescription: "",
    ogMeta: {},
    twitterMeta: {},
    jsonLd: [],
    headings: [],
    navLinks: [],
    htmlLang: "",
    hreflang: [],
    bodyText: "",
  };

  const { systemInstruction, userPrompt } = buildDiagnosePrompt(fallbackSignals, industry);

  const req: GenerateStructuredRequest<typeof BrandBriefSchema> = {
    modelId,
    prompt: userPrompt,
    systemInstruction,
    temperature: DIAGNOSE_TEMPERATURE,
    schema: BrandBriefSchema,
  };

  // ---- Single Gemini call --------------------------------------------------
  let structuredResult: GenerateStructuredResult<BrandBrief>;
  try {
    structuredResult = await adapter.generateStructured(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: `Unexpected error calling generateStructured: ${msg}`,
    };
  }

  // ---- NOT_CONFIGURED guard ------------------------------------------------
  if (!structuredResult.ok && structuredResult.code === NOT_CONFIGURED) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message:
        "GEMINI_API_KEY is not configured; cannot run URL diagnosis. " +
        (industry
          ? `Supply --industry "${industry}" only, or set GEMINI_API_KEY to run full diagnosis.`
          : "Set GEMINI_API_KEY to use the diagnose command."),
    };
  }

  // ---- Ledger the call (best-effort; non-blocking) -------------------------
  const usage = structuredResult.ok
    ? structuredResult.usage
    : ("usage" in structuredResult ? structuredResult.usage : undefined);

  if (usage !== undefined) {
    ledger
      .insertLlmCall({
        customerId,
        runId: null,
        purpose: "generation",
        provider: "gemini",
        modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usd: usage.usd,
        cacheHit: usage.cacheHit,
        responseRawId: null,
      })
      .catch((ledgerErr: unknown) => {
        // Non-fatal: ledger failure should not abort diagnosis.
        const msg = ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr);
        console.warn(`[diagnose] Ledger write failed (non-fatal): ${msg}`);
      });
  }

  // ---- Handle structured generation error ----------------------------------
  if (!structuredResult.ok) {
    // Map to a human-readable message
    const code = structuredResult.code;
    const errMsg =
      "message" in structuredResult && structuredResult.message
        ? structuredResult.message
        : `Gemini structured call failed with code: ${code}`;

    return {
      ok: false,
      code,
      message: errMsg,
    };
  }

  // ---- Return successful BrandBrief ----------------------------------------
  const brief = structuredResult.data;
  const mode: "full" | "industry-only" = effectiveSignals !== null ? "full" : "industry-only";

  return {
    ok: true,
    brief,
    mode,
    ...(robotsNote ? { robotsNote } : {}),
    ...(degradeReason ? { degradeReason } : {}),
  };
}
