"use client";

/**
 * GapList — Priority Gap questions sorted by gapScore (descending).
 *
 * Shows the highest-leverage content gaps where brand SMR is low and
 * competitor presence is high. Each row is expandable to show evidence refs.
 *
 * Props: PriorityGapQuestion[] from WireRunReport.priorityGap.questions
 * (verbatim @engine/domain/metrics.types).
 */

import { useState } from "react";
import type { PriorityGapQuestion } from "../lib/wire";

interface GapListProps {
  questions: PriorityGapQuestion[];
  /** Max questions to show before "show more". Default: 10 */
  limit?: number;
  /** If true, show evidence refs as expandable rows */
  showEvidence?: boolean;
  /** Called when user clicks "증거 보기" to open EvidenceDrawer */
  onEvidenceClick?: (evidenceRef: string) => void;
}

export function GapList({
  questions,
  limit = 10,
  showEvidence = false,
  onEvidenceClick,
}: GapListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!questions || questions.length === 0) {
    return (
      <div
        style={{
          padding: "24px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "var(--text-body-size)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
        }}
      >
        우선순위 콘텐츠 갭 없음 — 브랜드가 모든 질문에서 충분히 언급되고 있습니다.
      </div>
    );
  }

  const sorted = [...questions].sort((a, b) => b.gapScore - a.gapScore);
  const visible = sorted.slice(0, limit);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
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
              질문
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
                width: "100px",
              }}
            >
              브랜드 SMR
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
                width: "110px",
              }}
            >
              경쟁사 존재
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
                width: "90px",
              }}
            >
              갭 점수
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((q, idx) => {
            const isExpanded = expanded === q.questionId;
            return (
              <>
                <tr
                  key={q.questionId}
                  style={{
                    backgroundColor:
                      idx % 2 === 0 ? "var(--bg-elev)" : "var(--bg-subtle)",
                    borderBottom: isExpanded ? "none" : "1px solid var(--border)",
                    height: "var(--table-row-h)",
                    cursor: showEvidence && q.evidenceRefs.length > 0 ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (showEvidence && q.evidenceRefs.length > 0) {
                      setExpanded(isExpanded ? null : q.questionId);
                    }
                  }}
                >
                  <td
                    style={{
                      padding: "0 16px",
                      color: "var(--text)",
                    }}
                  >
                    <span
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {q.questionText}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "0 16px",
                      textAlign: "right",
                      color: q.brandSMR > 0.1 ? "var(--accent)" : "var(--negative)",
                    }}
                  >
                    {(q.brandSMR * 100).toFixed(1)}%
                  </td>
                  <td
                    style={{
                      padding: "0 16px",
                      textAlign: "right",
                      color:
                        q.competitorPresence > 0.5
                          ? "var(--warning)"
                          : "var(--text-muted)",
                    }}
                  >
                    {(q.competitorPresence * 100).toFixed(1)}%
                  </td>
                  <td
                    style={{
                      padding: "0 16px",
                      textAlign: "right",
                      color: "var(--text)",
                      fontWeight: 600,
                    }}
                  >
                    {q.gapScore.toFixed(2)}
                  </td>
                </tr>

                {isExpanded && showEvidence && (
                  <tr
                    key={`${q.questionId}-evidence`}
                    style={{
                      backgroundColor:
                        idx % 2 === 0 ? "var(--bg-elev)" : "var(--bg-subtle)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <td
                      colSpan={4}
                      style={{ padding: "8px 16px 12px 32px" }}
                    >
                      <div
                        style={{
                          fontSize: "var(--text-caption-size)",
                          color: "var(--text-muted)",
                          marginBottom: "6px",
                        }}
                      >
                        증거 응답 ({q.evidenceRefs.length}개):
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px",
                        }}
                      >
                        {q.evidenceRefs.map((ref) => (
                          <button
                            key={ref}
                            onClick={(e) => {
                              e.stopPropagation();
                              onEvidenceClick?.(ref);
                            }}
                            style={{
                              background: "var(--accent-weak)",
                              border: "1px solid var(--accent)",
                              borderRadius: "4px",
                              color: "var(--accent)",
                              fontSize: "11px",
                              padding: "2px 8px",
                              cursor: "pointer",
                              fontFamily: "monospace",
                            }}
                          >
                            {ref.slice(0, 8)}…
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>

      {sorted.length > limit && (
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--border)",
            backgroundColor: "var(--bg-elev)",
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          +{sorted.length - limit}개 더 있음 (전체 리포트에서 확인)
        </div>
      )}
    </div>
  );
}
