"use client";

/**
 * DeltaBadge — inline WoW delta indicator.
 *
 * Shows a green up / red down / muted no-change badge for a numeric delta.
 * Used in tables and KPI cards to show week-over-week changes.
 */

interface DeltaBadgeProps {
  /** The delta value (e.g. +0.031 means +3.1 percentage points). */
  delta: number | null | undefined;
  /** Format the absolute value as a percentage (×100). Default: true. */
  asPercent?: boolean;
  /** Number of decimal places. Default: 1. */
  decimals?: number;
}

export function DeltaBadge({
  delta,
  asPercent = true,
  decimals = 1,
}: DeltaBadgeProps) {
  if (delta === null || delta === undefined) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "2px",
          fontSize: "12px",
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-muted)",
        }}
      >
        —
      </span>
    );
  }

  const absValue = asPercent
    ? Math.abs(delta * 100).toFixed(decimals)
    : Math.abs(delta).toFixed(decimals);

  const isPositive = delta > 0;
  const isNegative = delta < 0;
  const isZero = delta === 0;

  const color = isPositive
    ? "var(--positive)"
    : isNegative
    ? "var(--negative)"
    : "var(--text-muted)";

  const arrow = isPositive ? "▲" : isNegative ? "▼" : "—";
  const label = isZero
    ? "±0"
    : `${isPositive ? "+" : "-"}${absValue}${asPercent ? "pt" : ""}`;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        fontSize: "12px",
        fontVariantNumeric: "tabular-nums",
        color,
        fontWeight: 600,
      }}
      aria-label={`WoW delta: ${label}`}
    >
      <span aria-hidden="true">{arrow}</span>
      <span>{isZero ? "±0" : `${absValue}${asPercent ? "pt" : ""}`}</span>
    </span>
  );
}
