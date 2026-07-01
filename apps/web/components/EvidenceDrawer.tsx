"use client";

/**
 * EvidenceDrawer — slide-in drawer for raw answer evidence.
 *
 * Fetches /api/evidence/[responseRawId] to show the raw answer_text
 * for a specific evidence reference. Tenant-checked on the server.
 *
 * §7#7 evidence traceability: every metric traces to evidence_refs →
 * response_raw rows → raw answer_text, surfaced here.
 *
 * Design: dark overlay + right-panel drawer, flat 1px-border, no animation
 * libraries. Thin line icons (lucide-style SVGs inline).
 */

import { useState, useEffect, useCallback } from "react";

interface EvidencePayload {
  responseRawId: string;
  answerText: string | null;
  modelId?: string;
  language?: string;
  capturedAt?: string;
}

interface EvidenceDrawerProps {
  /** The response_raw_id to fetch. null = closed. */
  evidenceId: string | null;
  /** Called when drawer should close */
  onClose: () => void;
}

export function EvidenceDrawer({ evidenceId, onClose }: EvidenceDrawerProps) {
  const [data, setData] = useState<EvidencePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEvidence = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setError("증거를 찾을 수 없습니다 (404).");
        return;
      }
      if (!res.ok) {
        setError(`오류: ${res.status}`);
        return;
      }
      const json = (await res.json()) as EvidencePayload;
      setData(json);
    } catch (e) {
      setError("네트워크 오류. 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (evidenceId) {
      void fetchEvidence(evidenceId);
    } else {
      setData(null);
      setError(null);
    }
  }, [evidenceId, fetchEvidence]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (evidenceId) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [evidenceId, onClose]);

  if (!evidenceId) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0,0,0,0.6)",
          zIndex: 40,
        }}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="증거 원문"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(520px, 90vw)",
          backgroundColor: "var(--bg-elev)",
          borderLeft: "1px solid var(--border)",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              color: "var(--text)",
            }}
          >
            증거 원문
          </h2>
          <button
            onClick={onClose}
            aria-label="닫기"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "4px",
              fontSize: "18px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {loading && (
            <p style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)" }}>
              불러오는 중…
            </p>
          )}

          {error && (
            <p
              style={{
                color: "var(--negative)",
                fontSize: "var(--text-body-size)",
                padding: "12px",
                border: "1px solid var(--negative)",
                borderRadius: "var(--radius-card)",
              }}
            >
              {error}
            </p>
          )}

          {data && (
            <>
              {/* Metadata */}
              <dl
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "4px 12px",
                  fontSize: "var(--text-caption-size)",
                  margin: 0,
                }}
              >
                <dt style={{ color: "var(--text-muted)" }}>응답 ID</dt>
                <dd
                  style={{
                    margin: 0,
                    fontFamily: "monospace",
                    color: "var(--text)",
                    fontSize: "11px",
                    wordBreak: "break-all",
                  }}
                >
                  {data.responseRawId}
                </dd>

                {data.modelId && (
                  <>
                    <dt style={{ color: "var(--text-muted)" }}>모델</dt>
                    <dd style={{ margin: 0, fontFamily: "monospace", color: "var(--accent)" }}>
                      {data.modelId}
                    </dd>
                  </>
                )}

                {data.language && (
                  <>
                    <dt style={{ color: "var(--text-muted)" }}>언어</dt>
                    <dd style={{ margin: 0, color: "var(--text)" }}>{data.language}</dd>
                  </>
                )}

                {data.capturedAt && (
                  <>
                    <dt style={{ color: "var(--text-muted)" }}>수집 시각</dt>
                    <dd style={{ margin: 0, color: "var(--text-muted)" }}>
                      {new Date(data.capturedAt).toLocaleString("ko-KR")}
                    </dd>
                  </>
                )}
              </dl>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
                <p
                  style={{
                    margin: "0 0 8px",
                    fontSize: "var(--text-caption-size)",
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                  }}
                >
                  원문 응답
                </p>
                {data.answerText ? (
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontSize: "13px",
                      lineHeight: "1.6",
                      color: "var(--text)",
                      backgroundColor: "var(--bg-subtle)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-card)",
                      padding: "12px 16px",
                    }}
                  >
                    {data.answerText}
                  </pre>
                ) : (
                  <p style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)" }}>
                    응답 텍스트 없음 (abstain 또는 오류)
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            fontSize: "11px",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          §7#7 — 모든 지표는 원문 응답으로 추적 가능합니다.
        </div>
      </aside>
    </>
  );
}
