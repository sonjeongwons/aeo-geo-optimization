"use client";

/**
 * apps/web/app/(staff)/templates/TemplateActions.tsx
 *
 * Client component for template action buttons (Review / Activate / Edit).
 *
 * Renders action buttons based on the current template status:
 *   DRAFT    → "검토 완료 (Review)" button
 *   REVIEWED → "검토 완료" (disabled/done) + "활성화 (Activate)" button
 *   ACTIVE   → no state-change buttons (already active)
 *
 * All status transitions use confirm() dialogs with clear warnings.
 * Activate shows a prominent warning about YAML regeneration + DB upsert.
 *
 * Edit (new draft) is available for ACTIVE and REVIEWED rows to start a new
 * draft version without mutating the existing row (append-only history).
 *
 * On action completion, the page auto-refreshes (router.refresh()) to show
 * the updated state from the Server Component.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  reviewTemplate,
  activateTemplate,
  editTemplate,
} from "../../../lib/actions/templates";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TemplateActionsProps {
  templateId: string;
  status: "draft" | "reviewed" | "active";
  industry: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TemplateActions({
  templateId,
  status,
  industry,
  version,
}: TemplateActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [showEditForm, setShowEditForm] = useState(false);
  const [editPayload, setEditPayload] = useState("");

  function clearMessage() {
    setMessage(null);
  }

  // ---------------------------------------------------------------------------
  // Review action (draft → reviewed)
  // ---------------------------------------------------------------------------

  function handleReview() {
    clearMessage();
    const confirmed = window.confirm(
      `템플릿 ${industry} v${version}을(를) REVIEWED로 전환하시겠습니까?\n\n` +
        `이 작업은 §5.5 첫 번째 게이트를 통과합니다. 활성화(Activate)는 별도 확인이 필요합니다.`,
    );
    if (!confirmed) return;

    startTransition(async () => {
      const result = await reviewTemplate(templateId);
      if (result.ok) {
        setMessage({
          type: "success",
          text: `검토 완료: ${result.result?.industry} v${result.result?.version} → REVIEWED`,
        });
        router.refresh();
      } else {
        setMessage({ type: "error", text: result.error ?? "알 수 없는 오류" });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Activate action (reviewed → active)
  // ---------------------------------------------------------------------------

  function handleActivate() {
    clearMessage();
    const confirmed = window.confirm(
      `⚠️ 주의: 템플릿 ${industry} v${version}을(를) ACTIVE로 활성화하시겠습니까?\n\n` +
        `이 작업은 다음을 수행합니다:\n` +
        `  1. 현재 ACTIVE 템플릿(${industry})을 REVIEWED로 강등\n` +
        `  2. 이 템플릿을 ACTIVE로 승격\n` +
        `  3. config/customers/<slug>.yaml 재생성 (YAML 파일 덮어쓰기)\n` +
        `  4. DB upsert: 고객·브랜드·경쟁사·질문·예산·언어 행 갱신\n\n` +
        `되돌릴 수 없습니다. 계속하시겠습니까?`,
    );
    if (!confirmed) return;

    startTransition(async () => {
      const result = await activateTemplate(templateId);
      if (result.ok && result.result) {
        setMessage({
          type: "success",
          text:
            `활성화 완료: ${result.result.industry} v${result.result.version} → ACTIVE | ` +
            `YAML: ${result.result.yamlPath} | ` +
            `질문 ${result.result.questionCount}개, 경쟁사 ${result.result.competitorCount}개`,
        });
        router.refresh();
      } else {
        setMessage({ type: "error", text: result.error ?? "알 수 없는 오류" });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Edit action (create new draft version)
  // ---------------------------------------------------------------------------

  function handleEditSubmit() {
    clearMessage();
    if (!editPayload.trim()) {
      setMessage({ type: "error", text: "JSON 페이로드를 입력하세요." });
      return;
    }

    // Validate JSON client-side first.
    try {
      JSON.parse(editPayload);
    } catch {
      setMessage({ type: "error", text: "유효하지 않은 JSON 형식입니다." });
      return;
    }

    const confirmed = window.confirm(
      `템플릿 ${industry} v${version}을 기반으로 새 DRAFT 버전을 생성하시겠습니까?\n\n` +
        `기존 행은 변경되지 않습니다 (불변 이력).`,
    );
    if (!confirmed) return;

    startTransition(async () => {
      const result = await editTemplate(templateId, editPayload);
      if (result.ok && result.result) {
        setMessage({
          type: "success",
          text:
            `새 DRAFT 생성 완료: ${result.result.industry} v${result.result.newVersion} ` +
            `(ID: ${result.result.newTemplateId.slice(0, 8)}…)`,
        });
        setShowEditForm(false);
        setEditPayload("");
        router.refresh();
      } else {
        setMessage({ type: "error", text: result.error ?? "알 수 없는 오류" });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const btnBase: React.CSSProperties = {
    display: "inline-block",
    padding: "5px 12px",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: 500,
    border: "none",
    cursor: isPending ? "not-allowed" : "pointer",
    opacity: isPending ? 0.6 : 1,
    textDecoration: "none",
    lineHeight: "18px",
    transition: "background 0.1s",
  };

  const btnReview: React.CSSProperties = {
    ...btnBase,
    background: "rgba(34,211,238,0.12)",
    color: "#22D3EE",
    border: "1px solid rgba(34,211,238,0.25)",
    marginRight: "6px",
  };

  const btnActivate: React.CSSProperties = {
    ...btnBase,
    background: "rgba(52,211,153,0.12)",
    color: "#34D399",
    border: "1px solid rgba(52,211,153,0.25)",
    marginRight: "6px",
  };

  const btnEdit: React.CSSProperties = {
    ...btnBase,
    background: "rgba(147,160,184,0.10)",
    color: "#93A0B8",
    border: "1px solid rgba(147,160,184,0.20)",
    marginRight: "6px",
  };

  const btnSubmit: React.CSSProperties = {
    ...btnBase,
    background: "#22D3EE",
    color: "#0B1020",
    fontWeight: 600,
    marginRight: "6px",
  };

  const btnCancel: React.CSSProperties = {
    ...btnBase,
    background: "transparent",
    color: "#93A0B8",
    border: "1px solid #1E2A44",
  };

  return (
    <div>
      {/* Action buttons */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
        {/* Review button: available only for DRAFT */}
        {status === "draft" && (
          <button
            style={btnReview}
            onClick={handleReview}
            disabled={isPending}
            title="draft → reviewed (§5.5 첫 번째 게이트)"
          >
            검토 완료
          </button>
        )}

        {/* Activate button: available only for REVIEWED */}
        {status === "reviewed" && (
          <button
            style={btnActivate}
            onClick={handleActivate}
            disabled={isPending}
            title="reviewed → active (YAML 재생성 + DB upsert)"
          >
            활성화
          </button>
        )}

        {/* Active status indicator */}
        {status === "active" && (
          <span
            style={{
              fontSize: "11px",
              color: "#34D399",
              fontWeight: 500,
            }}
          >
            현재 활성
          </span>
        )}

        {/* Edit button: create new draft (available for reviewed/active) */}
        {(status === "reviewed" || status === "active") && (
          <button
            style={btnEdit}
            onClick={() => {
              setShowEditForm(!showEditForm);
              clearMessage();
            }}
            disabled={isPending}
            title="새 DRAFT 버전 생성 (기존 행 불변)"
          >
            편집 (새 DRAFT)
          </button>
        )}

        {isPending && (
          <span style={{ fontSize: "11px", color: "#93A0B8" }}>처리 중…</span>
        )}
      </div>

      {/* Inline message */}
      {message && (
        <div
          style={{
            marginTop: "8px",
            padding: "8px 12px",
            borderRadius: "4px",
            fontSize: "12px",
            lineHeight: "18px",
            background:
              message.type === "success"
                ? "rgba(52,211,153,0.08)"
                : "rgba(248,113,113,0.08)",
            border: `1px solid ${
              message.type === "success"
                ? "rgba(52,211,153,0.25)"
                : "rgba(248,113,113,0.25)"
            }`,
            color: message.type === "success" ? "#34D399" : "#F87171",
            maxWidth: "320px",
          }}
        >
          {message.text}
          <button
            onClick={clearMessage}
            style={{
              float: "right",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              fontSize: "14px",
              lineHeight: 1,
              padding: "0 0 0 8px",
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Edit form (inline textarea for JSON payload) */}
      {showEditForm && (
        <div
          style={{
            marginTop: "12px",
            padding: "12px",
            background: "#0F1626",
            border: "1px solid #1E2A44",
            borderRadius: "6px",
            maxWidth: "480px",
          }}
        >
          <p
            style={{
              fontSize: "12px",
              color: "#93A0B8",
              margin: "0 0 8px 0",
              lineHeight: "18px",
            }}
          >
            편집된 질문/경쟁사 JSON 페이로드를 입력하세요.
            <br />
            형식:{" "}
            <code style={{ color: "#22D3EE", fontSize: "11px" }}>
              {"{ \"questions\": [...], \"competitors\": [...] }"}
            </code>
            <br />
            또는 질문 배열만 입력 시 기존 경쟁사를 유지합니다.
          </p>
          <textarea
            value={editPayload}
            onChange={(e) => setEditPayload(e.target.value)}
            rows={8}
            placeholder='{ "questions": [...], "competitors": [...] }'
            style={{
              width: "100%",
              background: "#0B1020",
              border: "1px solid #1E2A44",
              borderRadius: "4px",
              color: "#E6EAF2",
              fontSize: "12px",
              fontFamily: "monospace",
              padding: "8px",
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ marginTop: "8px", display: "flex", gap: "8px" }}>
            <button
              style={btnSubmit}
              onClick={handleEditSubmit}
              disabled={isPending}
            >
              새 DRAFT 생성
            </button>
            <button
              style={btnCancel}
              onClick={() => {
                setShowEditForm(false);
                setEditPayload("");
                clearMessage();
              }}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
