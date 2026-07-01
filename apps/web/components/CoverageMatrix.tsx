"use client";

/**
 * CoverageMatrix — models × mentioned coverage grid.
 *
 * Shows which LLM models mentioned the brand, with SMR values.
 * Cyan = mentioned (brand protagonist); slate = not mentioned.
 * Dense document-like data table, 40px rows, tabular-nums.
 *
 * Props come from WireRunReport.decomposition.byModel (verbatim @engine/domain type).
 */

import type { SMRByModel } from "../lib/wire";

interface CoverageMatrixProps {
  byModel: SMRByModel[];
}

export function CoverageMatrix({ byModel }: CoverageMatrixProps) {
  if (!byModel || byModel.length === 0) {
    return (
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "var(--text-caption-size)",
        }}
      >
        모델 데이터 없음
      </p>
    );
  }

  return (
    <div
      style={{
        overflowX: "auto",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "var(--text-body-size)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th
              style={{
                textAlign: "left",
                padding: "10px 16px",
                color: "var(--text-muted)",
                fontWeight: 600,
                fontSize: "var(--text-caption-size)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                backgroundColor: "var(--bg-elev)",
              }}
            >
              모델
            </th>
            <th
              style={{
                textAlign: "right",
                padding: "10px 16px",
                color: "var(--text-muted)",
                fontWeight: 600,
                fontSize: "var(--text-caption-size)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                backgroundColor: "var(--bg-elev)",
              }}
            >
              SMR
            </th>
            <th
              style={{
                textAlign: "right",
                padding: "10px 16px",
                color: "var(--text-muted)",
                fontWeight: 600,
                fontSize: "var(--text-caption-size)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                backgroundColor: "var(--bg-elev)",
              }}
            >
              언급 / 판정
            </th>
            <th
              style={{
                textAlign: "center",
                padding: "10px 16px",
                color: "var(--text-muted)",
                fontWeight: 600,
                fontSize: "var(--text-caption-size)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                backgroundColor: "var(--bg-elev)",
                width: "80px",
              }}
            >
              상태
            </th>
          </tr>
        </thead>
        <tbody>
          {byModel.map((row, idx) => {
            const mentioned = row.brandHits > 0;
            return (
              <tr
                key={row.modelId}
                style={{
                  backgroundColor:
                    idx % 2 === 0 ? "var(--bg-elev)" : "var(--bg-subtle)",
                  borderBottom: "1px solid var(--border)",
                  height: "var(--table-row-h)",
                }}
              >
                <td
                  style={{
                    padding: "0 16px",
                    color: "var(--text)",
                    fontFamily: "monospace",
                    fontSize: "13px",
                  }}
                >
                  {row.modelId}
                </td>
                <td
                  style={{
                    padding: "0 16px",
                    textAlign: "right",
                    color: mentioned ? "var(--accent)" : "var(--text-muted)",
                    fontWeight: mentioned ? 600 : 400,
                  }}
                >
                  {(row.smr * 100).toFixed(1)}%
                </td>
                <td
                  style={{
                    padding: "0 16px",
                    textAlign: "right",
                    color: "var(--text-muted)",
                  }}
                >
                  {row.brandHits} / {row.judgedOk}
                </td>
                <td style={{ padding: "0 16px", textAlign: "center" }}>
                  <span
                    style={{
                      display: "inline-block",
                      fontSize: "11px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      border: "1px solid currentColor",
                      color: mentioned ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {mentioned ? "언급됨" : "미언급"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
