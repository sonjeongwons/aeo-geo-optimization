/**
 * src/surfaces/nativeReview.ts
 *
 * Native-review flag resolution + optional advisory hook for market-language surfaces.
 *
 * DESIGN-phase4.md T14 / SPEC.md §4 (surfaces/tiers), §5 (measurement).
 *
 * ## Advisory-only semantics (T14 acceptance criterion: "SMR identical on/off")
 *
 * The native-review flag is PURELY ADVISORY. It does NOT affect:
 *   - the SMR calculation (mention_judgment rows are unchanged)
 *   - the judge pipeline (runResponse is unchanged)
 *   - the work-unit status (done/skipped/error transitions are unchanged)
 *
 * When a surface answer has nativeReview=true (market-language surface such as
 * Line JP/TW/TH, Kakao KR, or Naver KR), the pipeline emits a NativeReviewEvent
 * so the caller can route the answer to a human native-speaker review queue.
 * Whether that review happens has zero effect on the §5.2 SMR denominator/numerator.
 *
 * ## Usage in runCycle
 *
 * runCycle.ts accepts an optional `onNativeReview` hook in RunCycleDeps.
 * After each work-unit is processed (both PATH A sync and PATH B async), if the
 * work-unit produced a surface answer with nativeReview=true, the hook is called
 * with the NativeReviewEvent. The hook is fire-and-forget (errors are logged but
 * do NOT abort the cycle).
 *
 * ## Surface-to-flag resolution
 *
 * The flag is resolved from two sources, in priority order:
 *   1. `SurfaceAnswer.nativeReview` — set by the surface parser (parser-level
 *      knowledge of the specific response language).
 *   2. `requiresNativeReview(surfaceId)` — compliance manifest fallback (surface-
 *      level policy; always true for naverAi, line, kakao by manifest definition).
 *
 * Either source being true causes the event to fire.
 *
 * Pure module — no IO, no pg, no @google/genai.
 */

import pino from "pino";
import { requiresNativeReview } from "./compliance.js";
import type { SurfaceAnswer, SurfaceId } from "./types.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: "surfaces.nativeReview" });

// ---------------------------------------------------------------------------
// NativeReviewEvent — emitted when a market-language answer needs human QA
// ---------------------------------------------------------------------------

/**
 * Emitted when a surface answer is in a market language that requires
 * native-speaker review before the content is published / acted upon.
 *
 * The event is ADVISORY: it carries the answer for routing but does NOT
 * trigger any SMR re-computation or work-unit status change.
 *
 * Surfaces that trigger this event (per COMPLIANCE_MANIFEST):
 *   - naverAi  (Korean)
 *   - line     (Japanese / Traditional Chinese / Thai)
 *   - kakao    (Korean)
 */
export interface NativeReviewEvent {
  /**
   * The surface that produced the answer requiring native review.
   * One of: "naverAi" | "line" | "kakao" (the three market-language surfaces
   * defined with nativeReview=true in the COMPLIANCE_MANIFEST).
   */
  surfaceId: SurfaceId;

  /**
   * The answer text (prose only — citations stripped per §5.1 invariant).
   * This is what the native reviewer will read and sign off on.
   */
  answerText: string;

  /**
   * Citations associated with the answer (structured list, separate from prose).
   * May be empty if the surface response had no extractable citations.
   */
  citations: SurfaceAnswer["citations"];

  /**
   * The raw SERP API response or scraped DOM blob that produced this answer.
   * Stored verbatim as `provider_meta` JSONB in `response_raw` (§5.1).
   * Included here so the review queue can persist the full provenance.
   */
  rawInput: unknown;

  /**
   * ISO 8601 timestamp when the event was created (wall-clock time of
   * the pipeline run, not the scheduled time of the work-unit).
   */
  detectedAt: string;

  /**
   * Context from the pipeline run that produced this answer.
   * Used to correlate the review event with the run/work-unit records in DB.
   */
  context: NativeReviewContext;
}

/**
 * Pipeline context carried in NativeReviewEvent for correlation.
 */
export interface NativeReviewContext {
  /** The run ID (UUID) for the cycle that produced this answer. */
  runId: string;
  /** The customer ID (UUID) the run belongs to. */
  customerId: string;
  /** The question ID (UUID) that was answered. */
  questionId: string;
  /** The model/surface ID (e.g. "naverAi", "line", "kakao"). */
  modelId: string;
  /** The language of the work-unit (ISO 639-1 or BCP 47). */
  language: string;
  /** The sample index within the work-unit. Always 0 for serp/scrape surfaces. */
  sampleIdx: number;
}

// ---------------------------------------------------------------------------
// NativeReviewHook — optional caller-supplied callback
// ---------------------------------------------------------------------------

/**
 * A caller-supplied async callback that receives NativeReviewEvent instances.
 *
 * The hook is OPTIONAL and ADVISORY:
 *   - If absent, the pipeline proceeds normally (no-op).
 *   - If present, it is called after each work-unit that produces a surface
 *     answer with nativeReview=true.
 *   - Errors thrown by the hook are caught and logged; they do NOT abort
 *     the cycle or affect the SMR calculation.
 *
 * Typical implementations:
 *   - Insert a row into a native-review queue table.
 *   - Send a Slack notification to the market-language review team.
 *   - Write to a local file for offline review (development).
 *
 * The hook MUST NOT modify the answer text or citations (they are already
 * persisted). It is a side-channel notification, not a gating check.
 */
export type NativeReviewHook = (event: NativeReviewEvent) => Promise<void>;

// ---------------------------------------------------------------------------
// CycleNativeReviewHook — lightweight hook used at the runCycle level
// ---------------------------------------------------------------------------

/**
 * Lightweight hook variant used by runCycle.ts.
 *
 * runCycle operates at work-unit granularity and does NOT have direct access
 * to the SurfaceAnswer (which is produced inside runResponse and persisted to
 * DB before runCycle resumes). Therefore this hook receives only the pipeline
 * context identifiers — callers can query DB if they need the full answer text.
 *
 * The hook fires when a work-unit for a native-review surface has been
 * processed (i.e. the work-unit is done and the response_raw + mention_judgment
 * rows have already been committed). SMR is IDENTICAL whether this fires or not.
 *
 * Surfaces that trigger this hook (per COMPLIANCE_MANIFEST):
 *   - "naverAi"  (Korean)
 *   - "line"     (Japanese / Traditional Chinese / Thai)
 *   - "kakao"    (Korean)
 *
 * For PATH A (sync/inline) it fires immediately after the work-unit handler
 * returns. For PATH B (async/queue) it fires at enqueue time, since the actual
 * response processing happens asynchronously in the worker.
 */
export type CycleNativeReviewHook = (context: NativeReviewContext) => Promise<void>;

// ---------------------------------------------------------------------------
// modelRequiresNativeReview — check by model/surface ID (cycle-level helper)
// ---------------------------------------------------------------------------

/**
 * Return true when a model ID corresponds to a v1-b surface that requires
 * native-speaker review of its market-language answers.
 *
 * This is the cycle-level helper used by runCycle.ts, which knows only the
 * modelId (not the full SurfaceAnswer). It delegates to the compliance manifest.
 *
 * For non-surface models (chat/API modality without a manifest entry) this
 * returns false (no native review needed).
 *
 * @param modelId - The model identifier from the work-unit (e.g. "naverAi",
 *                  "line", "kakao", "gemini-2.5-flash", etc.)
 * @returns true for naverAi / line / kakao; false for all others.
 */
export function modelRequiresNativeReview(modelId: string): boolean {
  // Check if the modelId maps to a SurfaceId in the compliance manifest.
  // We use requiresNativeReview which safely returns false for unknown IDs.
  const knownNativeReviewSurfaces = new Set(["naverAi", "line", "kakao"]);
  return knownNativeReviewSurfaces.has(modelId);
}

// ---------------------------------------------------------------------------
// fireCycleNativeReviewHook — safe wrapper for the cycle-level hook
// ---------------------------------------------------------------------------

/**
 * Fire the cycle-level native-review hook for a work-unit, if applicable.
 *
 * This function:
 *   1. Checks if the work-unit's modelId belongs to a native-review surface.
 *   2. If yes and a hook is configured, calls the hook with the NativeReviewContext.
 *   3. Catches and LOGS any hook error without re-throwing (advisory-only;
 *      hook failures MUST NOT abort the cycle or alter the SMR calculation).
 *
 * ## SMR identity invariant (T14 acceptance criterion)
 *
 * This function is called AFTER the work-unit handler has returned (PATH A)
 * or at enqueue time (PATH B). All SMR-contributing DB rows (response_raw,
 * mention_judgment) are written BEFORE this fires. The hook is a pure
 * side-channel notification — SMR values are IDENTICAL whether the hook
 * fires, is absent, or throws.
 *
 * @param context  - Pipeline context for the work-unit.
 * @param hook     - Optional caller-supplied CycleNativeReviewHook.
 */
export async function fireCycleNativeReviewHook(
  context: NativeReviewContext,
  hook: CycleNativeReviewHook | undefined,
): Promise<void> {
  // No hook configured — fast path, no-op.
  if (!hook) return;

  // Check if the model/surface requires native review.
  if (!modelRequiresNativeReview(context.modelId)) return;

  try {
    await hook(context);
    log.debug(
      { modelId: context.modelId, runId: context.runId, questionId: context.questionId },
      "nativeReview: cycle hook fired successfully",
    );
  } catch (hookErr) {
    // Advisory-only: log the error but DO NOT re-throw.
    // SMR calculation is unaffected by hook failures.
    log.warn(
      { modelId: context.modelId, runId: context.runId, hookErr },
      "nativeReview: cycle hook threw an error (advisory — SMR unaffected)",
    );
  }
}

// ---------------------------------------------------------------------------
// resolveNativeReviewFlag — determine whether an answer needs native review
// ---------------------------------------------------------------------------

/**
 * Determine whether a surface answer requires native-speaker review.
 *
 * Resolution order (either source being true → flag = true):
 *   1. `answer.nativeReview` — parser-level flag (specific response language).
 *   2. `requiresNativeReview(answer.surfaceId)` — compliance manifest policy
 *      (surface-level invariant; always true for naverAi/line/kakao).
 *
 * @param answer - The parsed SurfaceAnswer from a serp/scrape surface adapter.
 * @returns true when native-speaker review is required; false otherwise.
 */
export function resolveNativeReviewFlag(answer: SurfaceAnswer): boolean {
  // Parser-level flag (may be set explicitly by the parser based on language detection).
  if (answer.nativeReview === true) return true;

  // Compliance manifest fallback — surface-level policy.
  return requiresNativeReview(answer.surfaceId);
}

// ---------------------------------------------------------------------------
// buildNativeReviewEvent — construct a NativeReviewEvent from pipeline data
// ---------------------------------------------------------------------------

/**
 * Build a NativeReviewEvent from a surface answer and pipeline context.
 *
 * Called by the pipeline (runCycle) after a work-unit completes, BEFORE
 * invoking the hook. Only called when resolveNativeReviewFlag() returns true.
 *
 * @param answer  - The surface answer (prose + citations).
 * @param context - Pipeline correlation context (runId, customerId, etc.).
 * @returns NativeReviewEvent ready to be passed to the hook.
 */
export function buildNativeReviewEvent(
  answer: SurfaceAnswer,
  context: NativeReviewContext,
): NativeReviewEvent {
  return {
    surfaceId: answer.surfaceId,
    answerText: answer.answerText,
    citations: answer.citations,
    rawInput: answer.rawInput,
    detectedAt: new Date().toISOString(),
    context,
  };
}

// ---------------------------------------------------------------------------
// fireNativeReviewHook — safe wrapper around the optional hook
// ---------------------------------------------------------------------------

/**
 * Fire the native-review hook for a work-unit result, if applicable.
 *
 * This function:
 *   1. Checks whether the adapter result carries a SurfaceAnswer with a
 *      nativeReview flag (or the surface is in the compliance manifest as
 *      a native-review surface).
 *   2. If yes and a hook is configured, calls the hook with a NativeReviewEvent.
 *   3. Catches and LOGS any hook error without re-throwing (advisory-only;
 *      hook failures MUST NOT abort the cycle or alter the SMR calculation).
 *
 * ## SMR identity invariant (T14 acceptance criterion)
 *
 * This function is called AFTER the work-unit has already been marked done
 * and all SMR-contributing DB rows (response_raw, mention_judgment) have been
 * written. The hook is a pure side-channel notification — calling it, skipping
 * it, or having it throw an error produces IDENTICAL SMR values.
 *
 * @param answer   - The SurfaceAnswer from the work-unit result. Pass undefined
 *                   if the work-unit produced no surface answer (hook is not called).
 * @param context  - Pipeline context for correlation.
 * @param hook     - The optional caller-supplied NativeReviewHook.
 */
export async function fireNativeReviewHook(
  answer: SurfaceAnswer | undefined,
  context: NativeReviewContext,
  hook: NativeReviewHook | undefined,
): Promise<void> {
  // No hook configured — fast path, no-op.
  if (!hook) return;

  // No surface answer (e.g. chat adapter, or surface returned NO_ANSWER).
  if (!answer) return;

  // Determine whether this answer needs native review.
  const needsReview = resolveNativeReviewFlag(answer);
  if (!needsReview) return;

  // Build the event and fire the hook.
  const event = buildNativeReviewEvent(answer, context);

  try {
    await hook(event);
    log.debug(
      { surfaceId: answer.surfaceId, runId: context.runId, questionId: context.questionId },
      "nativeReview: hook fired successfully",
    );
  } catch (hookErr) {
    // Advisory-only: log the error but DO NOT re-throw.
    // The SMR calculation is unaffected by hook failures.
    log.warn(
      { surfaceId: answer.surfaceId, runId: context.runId, hookErr },
      "nativeReview: hook threw an error (advisory — SMR unaffected)",
    );
  }
}
