/**
 * apps/web/components/ApprovalTable.tsx
 *
 * Generic approval table used by both the claims sign-off page and the deploy
 * approval page.
 *
 * gpto-style: dark navy surface, 40px dense rows, 1px --border, right-aligned
 * tabular-nums, status badges (11px uppercase). NO gradients, NO emoji.
 *
 * Props:
 *  - columns    : column definition list (header + accessor key)
 *  - rows       : row data objects (any shape; columns drive rendering)
 *  - onAction   : async callback called with the row id when the action button fires
 *  - actionLabel: label on the action button (e.g. "서명" | "승인")
 *  - emptyLabel : text shown when there are no rows
 *  - pendingId  : the row id currently being processed (for loading state)
 *  - errorId    : the row id that errored (for error highlight)
 *  - successIds : set of row ids that succeeded (for success highlight)
 */

import { RowAction } from "./RowAction";

export interface ApprovalColumn<T extends Record<string, unknown>> {
  header: string;
  key: keyof T;
  /** Render the cell value. If omitted, renders String(value). */
  render?: (value: T[keyof T], row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  width?: string | number;
}

export interface ApprovalTableProps<T extends Record<string, unknown>> {
  columns: ApprovalColumn<T>[];
  rows: T[];
  /** Key of the row that serves as the unique id for action callbacks. */
  idKey: keyof T;
  onAction: (id: string) => Promise<{ ok: boolean; error?: string; notFound?: boolean }>;
  actionLabel: string;
  /** Button label while processing. */
  actionPendingLabel?: string;
  emptyLabel?: string;
  /** Optional secondary column header for the action column. */
  actionColumnHeader?: string;
}

/**
 * Status badge (DRAFT / REVIEWED / ACTIVE / APPROVED / NEEDS_HUMAN etc.)
 */
export function StatusBadge({
  status,
}: {
  status: string;
}) {
  const badgeColors: Record<string, string> = {
    needs_human: "var(--warning)",
    pending: "var(--text-muted)",
    passed: "var(--positive)",
    blocked: "var(--negative)",
    queued: "var(--accent)",
    leased: "var(--text-muted)",
    published: "var(--positive)",
    failed: "var(--negative)",
  };

  const color = badgeColors[status.toLowerCase()] ?? "var(--text-muted)";

  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "11px",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color,
        borderRadius: "3px",
        padding: "2px 6px",
        border: `1px solid ${color}`,
        lineHeight: "18px",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function ApprovalTable<T extends Record<string, unknown>>({
  columns,
  rows,
  idKey,
  onAction,
  actionLabel,
  actionPendingLabel = "처리 중...",
  emptyLabel = "항목이 없습니다.",
  actionColumnHeader = "작업",
}: ApprovalTableProps<T>) {
  // Server Component: renders the table + cells (column `render` runs server-side).
  // The interactive per-row action button is the <RowAction> client island, which
  // receives the Server Action `onAction` (a "use server" function — allowed to cross).
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: "40px 24px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "var(--text-body-size)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          backgroundColor: "var(--bg-elev)",
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-card)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-body-size)", color: "var(--text)" }}>
        <thead>
          <tr style={{ backgroundColor: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
            {columns.map((col) => (
              <th
                key={String(col.key)}
                style={{
                  padding: "10px 16px",
                  textAlign: col.align ?? "left",
                  fontSize: "12px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap",
                  width: col.width,
                }}
              >
                {col.header}
              </th>
            ))}
            <th
              style={{
                padding: "10px 16px",
                textAlign: "right",
                fontSize: "12px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                width: "120px",
              }}
            >
              {actionColumnHeader}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const id = String(row[idKey]);
            const rowBg = i % 2 === 1 ? "var(--bg-subtle)" : "var(--bg-elev)";
            return (
              <tr
                key={id}
                style={{
                  backgroundColor: rowBg,
                  borderBottom: "1px solid var(--border)",
                  height: "40px",
                }}
              >
                {columns.map((col) => {
                  const val = row[col.key];
                  return (
                    <td
                      key={String(col.key)}
                      style={{
                        padding: "0 16px",
                        textAlign: col.align ?? "left",
                        fontVariantNumeric: "tabular-nums",
                        verticalAlign: "middle",
                        maxWidth: "320px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col.render
                        ? col.render(val, row)
                        : val === null || val === undefined
                        ? <span style={{ color: "var(--text-muted)" }}>—</span>
                        : String(val)}
                    </td>
                  );
                })}
                <td style={{ padding: "0 16px", textAlign: "right", verticalAlign: "middle" }}>
                  <RowAction
                    id={id}
                    onAction={onAction}
                    actionLabel={actionLabel}
                    actionPendingLabel={actionPendingLabel}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
