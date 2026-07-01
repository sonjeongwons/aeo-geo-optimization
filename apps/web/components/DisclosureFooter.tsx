"use client";

/**
 * DisclosureFooter — always-visible §0 / §7 disclosures.
 *
 * REQUIRED on every report view. Renders:
 *  1. The selfJudgeBiasDisclosure text from RunReport (verbatim SELF_JUDGE_BIAS_DISCLOSURE const)
 *  2. The §0 no-guarantee line: "현 위치 진단입니다 — 노출을 보장하지 않습니다."
 *  3. The §1 no-lock-in line (optional, shown on billing/plan surfaces)
 *
 * Rendered as quiet professional footnotes — never dismissible toasts/banners.
 * Color: --warning amber for the caveat notes, --text-muted for metadata.
 *
 * This component is a TESTED UI invariant: acceptance criterion requires
 * DisclosureFooter always shows both texts.
 */

interface DisclosureFooterProps {
  /** The selfJudgeBiasDisclosure string from WireRunReport */
  selfJudgeBiasDisclosure: string;
  /** Show the §1 no-lock-in line. Default: false */
  showNoLockIn?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function DisclosureFooter({
  selfJudgeBiasDisclosure,
  showNoLockIn = false,
  className,
}: DisclosureFooterProps) {
  return (
    <footer
      className={className}
      style={{
        borderTop: "1px solid var(--border)",
        marginTop: "32px",
        paddingTop: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
      data-testid="disclosure-footer"
    >
      {/* §0 no-guarantee — always present */}
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-caption-size)",
          lineHeight: "var(--text-caption-line)",
          color: "var(--warning)",
          fontWeight: 500,
        }}
        data-testid="no-guarantee-line"
      >
        현 위치 진단입니다 — 노출을 보장하지 않습니다. (§0)
      </p>

      {/* §7 self-judge bias disclosure — always present */}
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-caption-size)",
          lineHeight: "var(--text-caption-line)",
          color: "var(--text-muted)",
        }}
        data-testid="self-judge-bias-line"
      >
        {selfJudgeBiasDisclosure}
      </p>

      {/* §1 no-lock-in — optional, shown on billing/plan surfaces */}
      {showNoLockIn && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            lineHeight: "var(--text-caption-line)",
            color: "var(--text-muted)",
          }}
          data-testid="no-lock-in-line"
        >
          월단위·무약정 — 언제든 해지 가능합니다. (§1)
        </p>
      )}
    </footer>
  );
}
