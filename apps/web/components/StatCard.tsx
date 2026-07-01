"use client";

/**
 * StatCard — KPI summary card.
 *
 * Renders a single headline metric (large tabular-nums number) with a label,
 * optional WoW delta badge, and an optional warning/caveat note.
 * Used in the Overview page for SMR, Visibility, top SoV competitor, abstain rate.
 *
 * gpto-style: flat 1px-border card, dark navy surface, white numerals.
 * NO gradients, NO emoji, NO glassmorphism.
 */

import { DeltaBadge } from "./DeltaBadge";

interface StatCardProps {
  /** Card label, e.g. "Share of Model Response (SMR)" */
  label: string;
  /** Formatted value to display, e.g. "12.4%" or "0.83" */
  value: string;
  /** Optional raw delta for WoW badge (fractional, e.g. +0.031) */
  delta?: number | null;
  /** If true, renders delta as raw value, not percentage points */
  deltaRaw?: boolean;
  /** Optional caveat/warning text rendered in --warning amber */
  caveat?: string;
  /** Optional sub-label beneath the main value */
  subLabel?: string;
}

export function StatCard({
  label,
  value,
  delta,
  deltaRaw = false,
  caveat,
  subLabel,
}: StatCardProps) {
  return (
    <div
      className="card"
      style={{
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: "180px",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-caption-size)",
          lineHeight: "var(--text-caption-line)",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 600,
        }}
      >
        {label}
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "10px",
          flexWrap: "wrap",
        }}
      >
        <span
          className="metric"
          style={{
            fontSize: "var(--text-metric-size)",
            lineHeight: "var(--text-metric-line)",
            fontWeight: "var(--text-metric-weight)",
            color: "var(--text)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>

        {delta !== undefined && delta !== null && (
          <DeltaBadge delta={delta} asPercent={!deltaRaw} />
        )}
      </div>

      {subLabel && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          {subLabel}
        </p>
      )}

      {caveat && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--warning)",
            lineHeight: "var(--text-caption-line)",
          }}
        >
          {caveat}
        </p>
      )}
    </div>
  );
}
