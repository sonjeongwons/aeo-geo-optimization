"use client";

/**
 * FunnelCTA — conversion call-to-action panel.
 *
 * Used on the free-diagnostic result page to drive leads toward
 * the weekly report subscription or sales inquiry.
 *
 * gpto-style: flat 1px-border card, solid cyan primary button,
 * ghost secondary button. No emoji, no gradients.
 * §0 honesty line always visible beneath CTAs.
 */

interface FunnelCTAProps {
  /** Headline text */
  headline?: string;
  /** Body copy (optional) */
  body?: string;
  /** Primary CTA label */
  primaryLabel?: string;
  /** Primary CTA href */
  primaryHref?: string;
  /** Secondary CTA label */
  secondaryLabel?: string;
  /** Secondary CTA href */
  secondaryHref?: string;
  /** Whether to show the §0 no-guarantee caveat. Default: true */
  showNoGuarantee?: boolean;
}

export function FunnelCTA({
  headline = "주간 SMR 리포트 구독",
  body = "매주 월요일 아침, 브랜드의 AI 노출 변화를 이메일로 받아보세요.",
  primaryLabel = "주간 리포트 구독",
  primaryHref = "/contact",
  secondaryLabel = "영업 문의",
  secondaryHref = "/contact?type=sales",
  showNoGuarantee = true,
}: FunnelCTAProps) {
  return (
    <div
      className="card"
      style={{
        padding: "32px",
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        alignItems: "flex-start",
        maxWidth: "520px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2
          style={{
            margin: 0,
            fontSize: "var(--text-h1-size)",
            lineHeight: "var(--text-h1-line)",
            fontWeight: "var(--text-h1-weight)",
            color: "var(--text)",
          }}
        >
          {headline}
        </h2>
        {body && (
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-body-size)",
              lineHeight: "var(--text-body-line)",
              color: "var(--text-muted)",
            }}
          >
            {body}
          </p>
        )}
      </div>

      {/* Feature bullets */}
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          fontSize: "var(--text-body-size)",
          color: "var(--text-muted)",
        }}
      >
        {[
          "5개 LLM 모델 × 다국어 측정",
          "우선순위 콘텐츠 갭 분석",
          "WoW 트렌드 + 증거 원문 추적",
          "월단위·무약정",
        ].map((item) => (
          <li
            key={item}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: "14px" }}>
              ›
            </span>
            {item}
          </li>
        ))}
      </ul>

      {/* CTAs */}
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <a
          href={primaryHref}
          className="btn-primary"
          style={{ textDecoration: "none", display: "inline-block" }}
        >
          {primaryLabel}
        </a>
        <a
          href={secondaryHref}
          className="btn-ghost"
          style={{ textDecoration: "none", display: "inline-block" }}
        >
          {secondaryLabel}
        </a>
      </div>

      {/* §0 no-guarantee — always visible */}
      {showNoGuarantee && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--warning)",
            lineHeight: "var(--text-caption-line)",
          }}
        >
          현 위치 진단입니다 — 노출을 보장하지 않습니다. (§0)
        </p>
      )}
    </div>
  );
}
