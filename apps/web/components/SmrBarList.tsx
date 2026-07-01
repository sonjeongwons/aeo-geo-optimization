"use client";

/**
 * SmrBarList — horizontal bar list showing SMR breakdown by model or language.
 *
 * Renders a dense list of rows with a proportional bar in cyan
 * (brand) or slate-gray (secondary). No rainbow, no gradient.
 *
 * Props accept slices from WireRunReport.decomposition (verbatim types from @engine/domain).
 */

import type { SMRByModel, SMRByLanguage } from "../lib/wire";

type BarItem = {
  label: string;
  smr: number;
  brandHits: number;
  judgedOk: number;
};

function toItems(
  data: SMRByModel[] | SMRByLanguage[],
  kind: "model" | "language"
): BarItem[] {
  return data.map((item) => ({
    label: kind === "model" ? (item as SMRByModel).modelId : (item as SMRByLanguage).language,
    smr: item.smr,
    brandHits: item.brandHits,
    judgedOk: item.judgedOk,
  }));
}

interface SmrBarListProps {
  /** Either byModel or byLanguage from WireRunReport.decomposition */
  data: SMRByModel[] | SMRByLanguage[];
  kind: "model" | "language";
  /** Optional max bar width override (default "100%") */
  maxWidth?: string;
}

export function SmrBarList({ data, kind, maxWidth = "100%" }: SmrBarListProps) {
  const items = toItems(data, kind);

  if (!items || items.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-caption-size)" }}>
        데이터 없음
      </p>
    );
  }

  const maxSmr = Math.max(...items.map((i) => i.smr), 0.001);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: maxWidth }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "60%",
              }}
              title={item.label}
            >
              {item.label}
            </span>
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color: item.smr > 0 ? "var(--accent)" : "var(--text-muted)",
                fontWeight: 600,
              }}
            >
              {(item.smr * 100).toFixed(1)}%
            </span>
          </div>

          <div
            style={{
              height: "6px",
              backgroundColor: "var(--border)",
              borderRadius: "3px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${((item.smr / maxSmr) * 100).toFixed(1)}%`,
                backgroundColor: "var(--accent)",
                borderRadius: "3px",
                transition: "width 0.3s ease",
              }}
            />
          </div>

          <div
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {item.brandHits}/{item.judgedOk} 응답에서 언급
          </div>
        </div>
      ))}
    </div>
  );
}
