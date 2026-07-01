"use client";

/**
 * BreakdownTable — dense data table for decomposition slices.
 *
 * Generic table rendering SMR, Visibility, or SoV breakdowns.
 * 40px rows, tabular-nums, zebra on --bg-subtle, sticky header.
 *
 * Props accept WireRunReport slices (verbatim @engine/domain types).
 */

import type { SMRByModel, SMRByLanguage, SoV } from "../lib/wire";
import { DeltaBadge } from "./DeltaBadge";

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  render: (row: T) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// SMR by Model table
// ---------------------------------------------------------------------------

const SMR_BY_MODEL_COLS: Column<SMRByModel>[] = [
  {
    key: "modelId",
    label: "모델",
    align: "left",
    render: (r) => (
      <span style={{ fontFamily: "monospace", fontSize: "13px" }}>{r.modelId}</span>
    ),
  },
  {
    key: "smr",
    label: "SMR",
    align: "right",
    render: (r) => (
      <span style={{ color: r.smr > 0 ? "var(--accent)" : "var(--text-muted)" }}>
        {(r.smr * 100).toFixed(1)}%
      </span>
    ),
  },
  {
    key: "brandHits",
    label: "언급",
    align: "right",
    render: (r) => r.brandHits,
  },
  {
    key: "judgedOk",
    label: "판정",
    align: "right",
    render: (r) => r.judgedOk,
  },
];

// ---------------------------------------------------------------------------
// SMR by Language table
// ---------------------------------------------------------------------------

const SMR_BY_LANG_COLS: Column<SMRByLanguage>[] = [
  {
    key: "language",
    label: "언어",
    align: "left",
    render: (r) => (
      <span style={{ textTransform: "uppercase", fontWeight: 600 }}>{r.language}</span>
    ),
  },
  {
    key: "smr",
    label: "SMR",
    align: "right",
    render: (r) => (
      <span style={{ color: r.smr > 0 ? "var(--accent)" : "var(--text-muted)" }}>
        {(r.smr * 100).toFixed(1)}%
      </span>
    ),
  },
  {
    key: "brandHits",
    label: "언급",
    align: "right",
    render: (r) => r.brandHits,
  },
  {
    key: "judgedOk",
    label: "판정",
    align: "right",
    render: (r) => r.judgedOk,
  },
];

// ---------------------------------------------------------------------------
// SoV table
// ---------------------------------------------------------------------------

const SOV_COLS: Column<SoV>[] = [
  {
    key: "entityName",
    label: "엔티티",
    align: "left",
    render: (r) => <span style={{ fontWeight: 600 }}>{r.entityName}</span>,
  },
  {
    key: "value",
    label: "SoV",
    align: "right",
    render: (r) => (
      <span style={{ color: "var(--accent)" }}>
        {(r.value * 100).toFixed(1)}%
      </span>
    ),
  },
  {
    key: "entityMentions",
    label: "언급",
    align: "right",
    render: (r) => r.entityMentions,
  },
  {
    key: "totalMentions",
    label: "전체 언급",
    align: "right",
    render: (r) => r.totalMentions,
  },
];

// ---------------------------------------------------------------------------
// Generic table renderer
// ---------------------------------------------------------------------------

function GenericTable<T>({
  rows,
  columns,
  rowKey,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
}) {
  if (!rows || rows.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-caption-size)" }}>
        데이터 없음
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
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  textAlign: col.align ?? "left",
                  padding: "10px 16px",
                  color: "var(--text-muted)",
                  fontWeight: 600,
                  fontSize: "var(--text-caption-size)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  backgroundColor: "var(--bg-elev)",
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={rowKey(row)}
              style={{
                backgroundColor:
                  idx % 2 === 0 ? "var(--bg-elev)" : "var(--bg-subtle)",
                borderBottom: "1px solid var(--border)",
                height: "var(--table-row-h)",
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: "0 16px",
                    textAlign: col.align ?? "left",
                    color: "var(--text)",
                  }}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported composite
// ---------------------------------------------------------------------------

interface BreakdownTableProps {
  kind: "byModel" | "byLanguage" | "sov";
  byModel?: SMRByModel[];
  byLanguage?: SMRByLanguage[];
  sov?: SoV[];
}

export function BreakdownTable({ kind, byModel, byLanguage, sov }: BreakdownTableProps) {
  if (kind === "byModel" && byModel) {
    return (
      <GenericTable
        rows={byModel}
        columns={SMR_BY_MODEL_COLS}
        rowKey={(r) => r.modelId}
      />
    );
  }
  if (kind === "byLanguage" && byLanguage) {
    return (
      <GenericTable
        rows={byLanguage}
        columns={SMR_BY_LANG_COLS}
        rowKey={(r) => r.language}
      />
    );
  }
  if (kind === "sov" && sov) {
    return (
      <GenericTable
        rows={sov}
        columns={SOV_COLS}
        rowKey={(r) => r.entityName}
      />
    );
  }
  return (
    <p style={{ color: "var(--text-muted)", fontSize: "var(--text-caption-size)" }}>
      데이터 없음
    </p>
  );
}

// Re-export DeltaBadge for convenience
export { DeltaBadge };
