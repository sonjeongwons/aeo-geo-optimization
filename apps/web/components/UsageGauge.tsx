"use client";

/**
 * UsageGauge — billing usage bar (§11 / billing page).
 *
 * Shows current-period LLM spend vs monthly cap as a horizontal gauge.
 * Cyan fill up to the cap, amber warning at 80%+, red at 95%+.
 * Also shows cache-hit % as an efficiency/trust signal.
 *
 * No external deps beyond React.
 */

interface UsageGaugeProps {
  /** Current period spend in USD (raw provider cost, NOT customer price) */
  spentUsd: number;
  /** Monthly USD cap */
  capUsd: number;
  /** Cache-hit rate [0,1] — shown as efficiency signal */
  cacheHitRate?: number | null;
  /** Human-readable period label, e.g. "2026년 6월" */
  periodLabel?: string;
}

export function UsageGauge({
  spentUsd,
  capUsd,
  cacheHitRate,
  periodLabel,
}: UsageGaugeProps) {
  const pct = capUsd > 0 ? Math.min(spentUsd / capUsd, 1) : 0;
  const pctDisplay = (pct * 100).toFixed(1);

  const barColor =
    pct >= 0.95
      ? "var(--negative)"
      : pct >= 0.8
      ? "var(--warning)"
      : "var(--accent)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: "var(--text-caption-size)",
          color: "var(--text-muted)",
        }}
      >
        <span>
          {periodLabel ? `${periodLabel} ` : ""}API 사용량 (내부 원가)
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
          ${spentUsd.toFixed(4)} / ${capUsd.toFixed(2)}
        </span>
      </div>

      {/* Gauge bar */}
      <div
        style={{
          height: "10px",
          backgroundColor: "var(--border)",
          borderRadius: "5px",
          overflow: "hidden",
        }}
        role="progressbar"
        aria-valuenow={Math.round(pct * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`API 사용량 ${pctDisplay}%`}
      >
        <div
          style={{
            height: "100%",
            width: `${pctDisplay}%`,
            backgroundColor: barColor,
            borderRadius: "5px",
            transition: "width 0.3s ease",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "11px",
          color: pct >= 0.8 ? barColor : "var(--text-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>
          {pct >= 0.95
            ? "한도 초과 임박"
            : pct >= 0.8
            ? "한도 근접 중"
            : "정상 범위"}
          {" "}({pctDisplay}%)
        </span>
        {cacheHitRate !== undefined && cacheHitRate !== null && (
          <span>
            캐시 히트율{" "}
            <span style={{ color: "var(--positive)", fontWeight: 600 }}>
              {(cacheHitRate * 100).toFixed(1)}%
            </span>
          </span>
        )}
      </div>

      <p
        style={{
          margin: 0,
          fontSize: "11px",
          color: "var(--text-muted)",
        }}
      >
        * 이 수치는 당사의 API 원가(USD)이며, 고객 청구 금액(KRW)과 다릅니다.
        고객 가격은 질문 수 × 언어 수 기반 월정액입니다.
      </p>
    </div>
  );
}
