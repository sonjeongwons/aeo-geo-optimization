/**
 * apps/web/lib/format.ts
 *
 * Shared display formatters for the dashboard.
 *
 * W7.6 — NaN% guard: every percentage rendered at page level goes through
 * formatPct so a non-finite input (0/0, NaN, ±Infinity) renders an em-dash
 * "—" instead of the string "NaN%".
 */

/**
 * Format a fractional value (e.g. 0.124) as a percentage string ("12.4%").
 *
 * Returns "—" when the value is null/undefined or not finite (NaN, Infinity),
 * so no "NaN%" ever reaches the DOM.
 *
 * @param value    Fractional metric in [0,1] (or null).
 * @param digits   Decimal places (default 1).
 */
export function formatPct(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}
