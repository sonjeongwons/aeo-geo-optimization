/**
 * src/report/emailTemplate.ts
 *
 * Server-rendered HTML email template for the weekly SMR report.
 *
 * Design (DESIGN-phase5.md §"Report Automation"):
 * - Accepts a RunReport DTO and WoW delta; produces an HTML string.
 * - NO external templating engines — pure string interpolation is sufficient
 *   for a single weekly email template and keeps the engine dependency-free.
 * - §0 no-results-guarantee line is ALWAYS included.
 * - Self-judge-bias disclosure is ALWAYS included (§7 §5.4).
 * - gpto.kr visual system: dark navy/near-black, cyan accents, tabular-nums.
 *
 * NOTE: Email clients have limited CSS support. Inline styles are used
 * throughout. Background colors render correctly only in clients that support
 * CSS background-color in <td>/<div> (Gmail, Apple Mail, Outlook 2016+).
 */

import type { RunReport } from '../domain/metrics.types.js';
import type { ProportionComparison } from '../metrics/significance.js';

// ---------------------------------------------------------------------------
// Color tokens (inline style values, matching tokens.css)
// ---------------------------------------------------------------------------

const C = {
  bg: '#0B1020',
  bgElev: '#121A2E',
  bgSubtle: '#0F1626',
  border: '#1E2A44',
  text: '#E6EAF2',
  textMuted: '#93A0B8',
  accent: '#22D3EE',
  positive: '#34D399',
  negative: '#F87171',
  warning: '#FBBF24',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmt(v: number, decimals = 1): string {
  return v.toFixed(decimals);
}

function deltaStr(delta: number | null): string {
  if (delta === null) return '—';
  const abs = Math.abs(delta * 100).toFixed(1);
  return delta >= 0 ? `+${abs}pt` : `-${abs}pt`;
}

function deltaColor(delta: number | null): string {
  if (delta === null) return C.textMuted;
  return delta >= 0 ? C.positive : C.negative;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Main template
// ---------------------------------------------------------------------------

/**
 * Render the weekly SMR email as an HTML string.
 *
 * @param report        - The as-delivered RunReport (immutable snapshot).
 * @param wowDelta      - SMR delta vs previous completed operating run (null if none).
 * @param weekLabel     - Human-readable week label, e.g. "2026-W25".
 * @param permalinkUrl  - Optional signed /r/[token] permalink URL for the full report.
 * @param unsubUrl      - Optional unsubscribe / settings URL.
 * @param smrSignificance - Optional Fisher-exact significance of the WoW SMR delta (MUST #4).
 */
export function renderWeeklyReportEmail(params: {
  report: RunReport;
  wowDelta: number | null;
  weekLabel: string;
  permalinkUrl?: string;
  unsubUrl?: string;
  smrSignificance?: ProportionComparison | null;
}): { html: string; text: string; subject: string } {
  const { report, wowDelta, weekLabel, permalinkUrl, unsubUrl, smrSignificance } = params;

  const smrPct = pct(report.smr.value);
  const visibilityPct = pct(report.visibility.value);
  const abstainPct = pct(report.abstainRate);
  // Citation channel (MUST #2): brand cited as a linked SOURCE, not merely named.
  const citationPct = report.citationShare ? pct(report.citationShare.value) : null;
  const citationOfMentionPct = report.citationShare
    ? pct(report.citationShare.citationOfMentionRate)
    : null;
  // Recommendation channel (R1): the third funnel tier — affirmatively advised.
  const recommendationPct = report.recommendationShare ? pct(report.recommendationShare.value) : null;
  const recommendationOfMentionPct = report.recommendationShare
    ? pct(report.recommendationShare.recommendationOfMentionRate)
    : null;

  const topSov = report.sov.length > 0
    ? report.sov.reduce((a, b) => a.value > b.value ? a : b)
    : null;

  // Top-3 priority gap questions
  const top3Gaps = [...report.priorityGap.questions]
    .sort((a, b) => b.gapScore - a.gapScore)
    .slice(0, 3);

  const subject = `주간 SMR 리포트 — ${weekLabel} — SMR ${smrPct} (${deltaStr(wowDelta)})`;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.text};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};min-height:100vh;">
<tr><td align="center" style="padding:32px 16px;">

  <!-- Container -->
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

    <!-- Header -->
    <tr><td style="padding-bottom:24px;border-bottom:1px solid ${C.border};">
      <p style="margin:0;font-size:12px;color:${C.textMuted};text-transform:uppercase;letter-spacing:0.08em;">AEO/GEO 주간 리포트</p>
      <h1 style="margin:4px 0 0;font-size:24px;font-weight:700;color:${C.text};">${escHtml(weekLabel)}</h1>
    </td></tr>

    <!-- KPI Row -->
    <tr><td style="padding:24px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <!-- SMR -->
          <td width="33%" style="padding:16px;background:${C.bgElev};border:1px solid ${C.border};border-radius:8px;vertical-align:top;">
            <p style="margin:0 0 4px;font-size:11px;color:${C.textMuted};text-transform:uppercase;">SMR</p>
            <p style="margin:0;font-size:32px;font-weight:700;color:${C.accent};font-variant-numeric:tabular-nums;">${escHtml(smrPct)}</p>
            <p style="margin:4px 0 0;font-size:13px;color:${deltaColor(wowDelta)};font-variant-numeric:tabular-nums;">${escHtml(deltaStr(wowDelta))} WoW</p>
            ${smrSignificance ? `<p style="margin:4px 0 0;font-size:11px;color:${smrSignificance.significant ? C.textMuted : C.warning};line-height:1.4;">${smrSignificance.significant
              ? `통계적으로 유의 (p=${smrSignificance.pValue.toFixed(3)})`
              : `유의하지 않음 (p=${smrSignificance.pValue.toFixed(2)}${smrSignificance.lowPower ? ', 표본 부족' : ''}) — 노이즈 가능`}</p>` : ''}
          </td>
          <!-- Spacer -->
          <td width="12"></td>
          <!-- Visibility -->
          <td width="33%" style="padding:16px;background:${C.bgElev};border:1px solid ${C.border};border-radius:8px;vertical-align:top;">
            <p style="margin:0 0 4px;font-size:11px;color:${C.textMuted};text-transform:uppercase;">Visibility</p>
            <p style="margin:0;font-size:32px;font-weight:700;color:${C.text};font-variant-numeric:tabular-nums;">${escHtml(visibilityPct)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:${C.textMuted};">가중 노출 지수</p>
          </td>
          <!-- Spacer -->
          <td width="12"></td>
          <!-- Top SoV -->
          <td width="33%" style="padding:16px;background:${C.bgElev};border:1px solid ${C.border};border-radius:8px;vertical-align:top;">
            <p style="margin:0 0 4px;font-size:11px;color:${C.textMuted};text-transform:uppercase;">${topSov ? `SoV vs ${escHtml(topSov.entityName)}` : 'SoV'}</p>
            <p style="margin:0;font-size:32px;font-weight:700;color:${C.text};font-variant-numeric:tabular-nums;">${topSov ? escHtml(pct(topSov.value)) : '—'}</p>
            <p style="margin:4px 0 0;font-size:12px;color:${C.textMuted};">Share of Voice</p>
          </td>
        </tr>
      </table>
    </td></tr>

    ${citationPct ? `
    <!-- Citation channel (MUST #2): mention vs cited-as-source -->
    <tr><td style="padding:0 0 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:16px;background:rgba(96,165,250,0.06);border:1px solid ${C.border};border-radius:8px;vertical-align:top;">
            <p style="margin:0 0 4px;font-size:11px;color:${C.textMuted};text-transform:uppercase;">SMR (Citation) — 인용(출처 링크) 기준</p>
            <p style="margin:0;font-size:28px;font-weight:700;color:${C.accent};font-variant-numeric:tabular-nums;">${escHtml(citationPct)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:${C.textMuted};line-height:1.5;">
              언급(mention) ${escHtml(smrPct)} 중 ${escHtml(citationOfMentionPct ?? '—')}가 실제 <strong>인용(링크/출처)</strong>으로 노출됨. 인용은 언급의 부분집합이며 클릭 가능한 트래픽 레버입니다.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
    ` : ''}

    ${recommendationPct ? `
    <!-- Recommendation channel (R1): the third funnel tier -->
    <tr><td style="padding:0 0 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:16px;background:rgba(52,211,153,0.06);border:1px solid ${C.border};border-radius:8px;vertical-align:top;">
            <p style="margin:0 0 4px;font-size:11px;color:${C.textMuted};text-transform:uppercase;">SMR (Recommendation) — 추천(권장) 기준</p>
            <p style="margin:0;font-size:28px;font-weight:700;color:${C.accent};font-variant-numeric:tabular-nums;">${escHtml(recommendationPct)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:${C.textMuted};line-height:1.5;">
              언급 중 ${escHtml(recommendationOfMentionPct ?? '—')}가 실제 <strong>추천(best/top/권장)</strong>으로 노출됨. 퍼널: 언급 → 인용 → 추천. 보수적 하한값(결정론적 탐지).
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
    ` : ''}

    <!-- Abstain note -->
    ${report.abstainRate > 0.1 ? `
    <tr><td style="padding:12px 16px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:6px;margin-bottom:24px;">
      <p style="margin:0;font-size:12px;color:${C.warning};">⚠ Abstain rate ${escHtml(abstainPct)} — 일부 응답에서 판정 보류(abstain)가 발생했습니다. 신뢰 지표에 영향을 줄 수 있습니다.</p>
    </td></tr>
    ` : ''}

    <!-- Model coverage -->
    ${report.decomposition.byModel.length > 0 ? `
    <tr><td style="padding-top:24px;">
      <h2 style="margin:0 0 12px;font-size:16px;font-weight:600;color:${C.text};">모델별 SMR</h2>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr style="background:${C.bgSubtle};">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:${C.textMuted};font-weight:500;border-bottom:1px solid ${C.border};">모델</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:${C.textMuted};font-weight:500;border-bottom:1px solid ${C.border};font-variant-numeric:tabular-nums;">SMR</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:${C.textMuted};font-weight:500;border-bottom:1px solid ${C.border};font-variant-numeric:tabular-nums;">언급 / 판정</th>
        </tr>
        ${report.decomposition.byModel.map((m, i) => `
        <tr style="background:${i % 2 === 1 ? C.bgSubtle : 'transparent'};">
          <td style="padding:8px 12px;font-size:13px;color:${C.text};border-bottom:1px solid ${C.border};">${escHtml(m.modelId)}</td>
          <td style="padding:8px 12px;text-align:right;font-size:13px;color:${C.accent};font-variant-numeric:tabular-nums;border-bottom:1px solid ${C.border};">${escHtml(pct(m.smr))}</td>
          <td style="padding:8px 12px;text-align:right;font-size:13px;color:${C.textMuted};font-variant-numeric:tabular-nums;border-bottom:1px solid ${C.border};">${m.brandHits} / ${m.judgedOk}</td>
        </tr>`).join('')}
      </table>
    </td></tr>
    ` : ''}

    <!-- Priority gaps -->
    ${top3Gaps.length > 0 ? `
    <tr><td style="padding-top:24px;">
      <h2 style="margin:0 0 4px;font-size:16px;font-weight:600;color:${C.text};">우선순위 갭 (상위 3개)</h2>
      <p style="margin:0 0 12px;font-size:12px;color:${C.textMuted};">경쟁사가 언급되는데 브랜드가 미언급된 질문</p>
      ${top3Gaps.map((q, i) => `
      <div style="padding:12px 16px;background:${C.bgElev};border:1px solid ${C.border};border-radius:6px;${i > 0 ? 'margin-top:8px;' : ''}">
        <p style="margin:0 0 6px;font-size:13px;color:${C.text};">${escHtml(q.questionText)}</p>
        <p style="margin:0;font-size:12px;color:${C.textMuted};font-variant-numeric:tabular-nums;">
          Brand SMR: <span style="color:${C.text};">${escHtml(pct(q.brandSMR))}</span>
          &nbsp;·&nbsp;
          Competitor presence: <span style="color:${C.text};">${escHtml(pct(q.competitorPresence))}</span>
          &nbsp;·&nbsp;
          Gap score: <span style="color:${C.warning};">${escHtml(fmt(q.gapScore))}</span>
        </p>
      </div>`).join('')}
      <p style="margin:8px 0 0;font-size:11px;color:${C.textMuted};">나머지 갭 질문은 대시보드에서 확인하세요.</p>
    </td></tr>
    ` : ''}

    ${permalinkUrl ? `
    <!-- Report permalink CTA -->
    <tr><td style="padding-top:24px;text-align:center;">
      <a href="${escHtml(permalinkUrl)}"
         style="display:inline-block;padding:12px 28px;background:${C.accent};color:#0B1020;font-size:14px;font-weight:700;border-radius:6px;text-decoration:none;letter-spacing:0.02em;">
        전체 리포트 보기 →
      </a>
    </td></tr>
    ` : ''}

    <!-- Disclosures -->
    <tr><td style="padding-top:32px;border-top:1px solid ${C.border};margin-top:32px;">
      <p style="margin:0 0 8px;font-size:11px;color:${C.textMuted};line-height:1.6;">
        <strong style="color:${C.warning};">성과(노출) 보장 없음 —</strong>
        이 리포트는 현재 AI 모델 노출 상태를 측정한 결과입니다. 개선을 보장하지 않습니다. (§0)
      </p>
      <p style="margin:0 0 8px;font-size:11px;color:${C.textMuted};line-height:1.6;">
        <strong>Self-judge bias disclosure:</strong> ${escHtml(report.selfJudgeBiasDisclosure)}
      </p>
      <p style="margin:0;font-size:11px;color:${C.textMuted};line-height:1.6;">
        측정 범위: 총 ${report.smr.nTotal}개 응답 / Abstain ${escHtml(abstainPct)} / 생성: ${report.generatedAt.toISOString()}
      </p>
      ${report.measurementQuality ? `<p style="margin:8px 0 0;font-size:11px;color:${report.measurementQuality.status === 'good' ? C.textMuted : C.warning};line-height:1.6;">
        <strong>측정 품질 (${escHtml(report.measurementQuality.status)}):</strong> ${escHtml(report.measurementQuality.note)}
      </p>` : ''}
      ${unsubUrl ? `<p style="margin:8px 0 0;font-size:11px;color:${C.textMuted};">
        <a href="${escHtml(unsubUrl)}" style="color:${C.textMuted};">수신 설정 변경</a>
      </p>` : ''}
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;

  // Plain text fallback
  const lines: string[] = [
    `주간 SMR 리포트 — ${weekLabel}`,
    '',
    `SMR: ${smrPct}  (WoW: ${deltaStr(wowDelta)})`,
    smrSignificance
      ? `  ↳ ${smrSignificance.significant ? '통계적으로 유의' : '유의하지 않음'} (Fisher p=${smrSignificance.pValue.toFixed(3)}${smrSignificance.lowPower ? ', 표본 부족' : ''})`
      : '',
    citationPct ? `SMR (Citation/인용): ${citationPct}  (언급 중 ${citationOfMentionPct ?? '—'} 인용)` : '',
    recommendationPct ? `SMR (Recommendation/추천): ${recommendationPct}  (언급 중 ${recommendationOfMentionPct ?? '—'} 추천)` : '',
    `Visibility: ${visibilityPct}`,
    topSov ? `SoV vs ${topSov.entityName}: ${pct(topSov.value)}` : '',
    '',
    '--- 우선순위 갭 (상위 3개) ---',
    ...top3Gaps.map((q, i) => `${i + 1}. ${q.questionText}  [gap score: ${fmt(q.gapScore)}]`),
    '',
    permalinkUrl ? `전체 리포트: ${permalinkUrl}` : '',
    '',
    '--- 공시 ---',
    '성과(노출) 보장 없음 — 이 리포트는 현재 상태 측정 결과입니다.',
    report.selfJudgeBiasDisclosure,
    `측정 범위: ${report.smr.nTotal}개 응답 / Abstain ${abstainPct}`,
  ].filter((l) => l !== undefined);

  return { html, text: lines.join('\n'), subject };
}
