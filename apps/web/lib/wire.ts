/**
 * Wire DTOs — Date fields converted to ISO strings so RunReport
 * can safely cross the RSC→client component boundary.
 *
 * RunReport.generatedAt and run timestamps are JS Date objects.
 * Passing a Date across the RSC boundary serializes to a string while
 * the shared type still declares Date, causing mismatches in charts/tables.
 * An explicit wire DTO keeps the shared type honest about the runtime shape.
 *
 * Rules:
 *  - Server components call toWireReport() before passing to client components.
 *  - Client components receive WireRunReport (strings), never RunReport (Dates).
 *  - This module has NO server-only imports and is safe to import anywhere.
 */

import type {
  RunReport,
  SMR,
  Visibility,
  SoV,
  PriorityGap,
  PriorityGapQuestion,
  SMRDecomposition,
  SMRByModel,
  SMRByLanguage,
  SMRByQuestion,
  MetricTuple,
} from "@engine/domain/metrics.types";

// Re-export the pure metric types — these have no Dates and can cross the
// boundary as-is, so client components import from here rather than
// @engine/domain directly (avoids a need for type-stripping imports).
export type {
  SMR,
  Visibility,
  SoV,
  PriorityGap,
  PriorityGapQuestion,
  SMRDecomposition,
  SMRByModel,
  SMRByLanguage,
  SMRByQuestion,
  MetricTuple,
};

// ---------------------------------------------------------------------------
// WireRunReport — RunReport with Date → ISO string
// ---------------------------------------------------------------------------

/**
 * Wire-safe version of RunReport.
 * All Date fields are replaced with ISO-8601 strings.
 * This is the ONLY shape passed to client-side components (charts, tables).
 */
export type WireRunReport = Omit<RunReport, "generatedAt"> & {
  generatedAt: string; // ISO 8601
};

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Convert a RunReport (with JS Date) to a WireRunReport (with ISO strings).
 * Call this in Server Components / Route Handlers BEFORE passing to client components.
 *
 * @param report - The engine RunReport (contains JS Date fields).
 * @returns A plain-object WireRunReport safe to serialize across the RSC boundary.
 */
export function toWireReport(report: RunReport): WireRunReport {
  return {
    ...report,
    generatedAt: report.generatedAt.toISOString(),
  };
}
