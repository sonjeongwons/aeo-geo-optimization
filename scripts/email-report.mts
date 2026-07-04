/** scripts/email-report.mts
 *
 * Build a self-contained Korean HTML email that tracks AEO/GEO progress per
 * customer: the headline funnel (언급/인용/추천률), the improvement vs the
 * previous measurement (전대비 개선율), a CUMULATIVE table of EVERY measured date,
 * and the owned-net hub page count. Writes report-email.html + report-subject.txt
 * (a GitHub Action mails them). Optionally sends directly via Resend when
 * RESEND_API_KEY is set.
 *
 * Data source: run + run_smr_overall (completed runs with n_total>0) + url_registry
 * (published owned_net pages per hub). No LLM cost. §7: reports measured facts only.
 *
 * Usage: npx tsx scripts/email-report.mts   (env REPORT_TO default doradola38@gmail.com)
 */
import "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { promises as fs } from "node:fs";

const REPORT_TO = process.env["REPORT_TO"] ?? "doradola38@gmail.com";

// Customer roster (slug, display name, hub base URL for page counts).
const CUSTOMERS = [
  { slug: "smimdate", name: "스밈 (SMIM)", hub: "https://sonjeongwons.github.io/aeo-smim-hub" },
  { slug: "emora", name: "EMORA", hub: "https://sonjeongwons.github.io/aeo-owned-net-hub" },
];

interface Point {
  date: string;
  nTotal: number;
  judged: number;
  mention: number; // brand_hits
  citation: number;
  recommendation: number;
}

function pct(hits: number, denom: number): number {
  return denom > 0 ? (hits / denom) * 100 : 0;
}
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

/**
 * Wilson 95% score interval for a binomial rate, returned as [low%, high%].
 * Honest small-sample uncertainty (§7): a single-point rate over a handful of
 * judged responses is nearly meaningless without its interval.
 */
function wilsonCi(hits: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - margin) / denom) * 100, Math.min(1, (centre + margin) / denom) * 100];
}

/** Below this judged-sample size a rate is flagged low-power (§7 honesty). */
const LOW_POWER_N = 100;

/** Friendly display label for a measured model_id; falls back to the raw id. */
const MODEL_LABELS: Record<string, string> = {
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
};
function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id;
}
function deltaBadge(cur: number, prev: number | null): string {
  if (prev === null) return `<span style="color:#888">기준</span>`;
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return `<span style="color:#888">±0.0pt</span>`;
  const up = d > 0;
  const color = up ? "#0a7d32" : "#b00020";
  const arrow = up ? "▲" : "▼";
  return `<span style="color:${color};font-weight:600">${arrow} ${up ? "+" : ""}${d.toFixed(1)}pt</span>`;
}

async function pointsFor(customerId: string): Promise<Point[]> {
  const db = getDb();
  const rows = await db
    .selectFrom("run as r")
    .leftJoin("run_smr_overall as s", "s.run_id", "r.id")
    .select([
      "r.finished_at",
      "r.n_total",
      "s.judged_ok",
      "s.brand_hits",
      "s.citation_hits",
      "s.recommendation_hits",
    ] as never)
    .where("r.customer_id", "=", customerId)
    .where("r.status", "=", "completed")
    .where("r.n_total", ">", 0)
    .orderBy("r.finished_at", "asc")
    .execute();
  return (rows as never[]).map((x: never) => {
    const r = x as Record<string, unknown>;
    const d = r["finished_at"] as Date | string | null;
    return {
      date: d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : "—",
      nTotal: Number(r["n_total"] ?? 0),
      judged: Number(r["judged_ok"] ?? 0),
      mention: Number(r["brand_hits"] ?? 0),
      citation: Number(r["citation_hits"] ?? 0),
      recommendation: Number(r["recommendation_hits"] ?? 0),
    };
  });
}

/** Distinct answer models actually measured for this customer (honest scope). */
async function enginesFor(customerId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectFrom("mention_judgment")
    .select("model_id")
    .distinct()
    .where("customer_id", "=", customerId)
    .execute();
  return (rows as Array<{ model_id: string }>).map((r) => modelLabel(r.model_id)).sort();
}

async function pageCount(hub: string): Promise<number> {
  const db = getDb();
  const row = await db
    .selectFrom("url_registry")
    .select((eb) => eb.fn.count<number>("id").as("n"))
    .where("publish_status", "=", "published")
    .where("channel_class", "=", "owned_net")
    .where("published_url", "like", `${hub}%`)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

function customerSection(c: { name: string }, pts: Point[], pages: number, engines: string[]): string {
  // Honest engine-scope label (§7 W2.2): name the model(s) actually measured
  // instead of implying broad multi-engine coverage.
  const scope =
    engines.length === 0
      ? ""
      : ` · 측정 엔진: ${engines.join(", ")}${engines.length === 1 ? " (단일 모델 기준 recall)" : ""}`;
  if (pts.length === 0) {
    return `<h2 style="margin:24px 0 8px">${c.name}</h2><p style="color:#666">아직 측정 데이터가 없습니다. 다음 측정 사이클에 채워집니다. (발행 페이지 ${pages}개)</p>`;
  }
  // Rates by judged denominator (판정된 응답 기준); denom falls back to nTotal.
  const rate = (p: Point, hits: number) => pct(hits, p.judged > 0 ? p.judged : p.nTotal);
  const latest = pts[pts.length - 1]!;
  const prev = pts.length > 1 ? pts[pts.length - 2]! : null;
  const denomOf = (p: Point) => (p.judged > 0 ? p.judged : p.nTotal);
  const lDenom = denomOf(latest);
  const lowPower = lDenom < LOW_POWER_N;
  const lm = rate(latest, latest.mention);
  const lc = rate(latest, latest.citation);
  const lr = rate(latest, latest.recommendation);
  const pm = prev ? rate(prev, prev.mention) : null;
  const pc = prev ? rate(prev, prev.citation) : null;
  const pr = prev ? rate(prev, prev.recommendation) : null;

  const ciStr = (hits: number): string => {
    const [lo, hi] = wilsonCi(hits, lDenom);
    return `<div style="font-size:11px;color:#888">95% 신뢰구간 ${fmtPct(lo)}–${fmtPct(hi)}</div>`;
  };

  const cards = [
    { label: "언급률 (Mention / SMR)", cur: lm, prev: pm, hits: latest.mention },
    { label: "인용률 (Citation)", cur: lc, prev: pc, hits: latest.citation },
    { label: "추천률 (Recommendation)", cur: lr, prev: pr, hits: latest.recommendation },
  ]
    .map(
      (k) => `<td style="padding:10px 14px;border:1px solid #eee;border-radius:8px;vertical-align:top">
        <div style="font-size:12px;color:#666">${k.label}</div>
        <div style="font-size:22px;font-weight:700;margin:2px 0">${fmtPct(k.cur)}</div>
        ${ciStr(k.hits)}
        <div style="font-size:12px">전대비 ${deltaBadge(k.cur, k.prev)}</div>
      </td>`,
    )
    .join('<td style="width:8px"></td>');

  const lowPowerBadge = lowPower
    ? `<div style="font-size:12px;color:#b06a00;background:#fff6e5;border:1px solid #ffe0a3;border-radius:6px;padding:6px 10px;margin:6px 0">⚠ 표본 부족 (판정 응답 ${lDenom}개 &lt; ${LOW_POWER_N}) — 위 비율과 신뢰구간의 불확실성이 큽니다. 표본이 쌓이며 정밀도가 올라갑니다.</div>`
    : "";

  const histRows = pts
    .map((p, i) => {
      const prevP = i > 0 ? pts[i - 1]! : null;
      const m = rate(p, p.mention);
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0">${p.date}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${p.nTotal}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${fmtPct(m)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${fmtPct(rate(p, p.citation))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${fmtPct(rate(p, p.recommendation))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${deltaBadge(m, prevP ? rate(prevP, prevP.mention) : null)}</td>
      </tr>`;
    })
    .join("\n");

  return `<h2 style="margin:26px 0 6px">${c.name} <span style="font-size:13px;color:#888;font-weight:400">· 발행 페이지 ${pages}개 · 측정 ${pts.length}회${scope}</span></h2>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0"><tr>${cards}</tr></table>
    ${lowPowerBadge}
    <div style="font-size:13px;color:#555;margin:10px 0 4px">누적 측정 히스토리 (모든 날짜)</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#fafafa;text-align:right">
        <th style="padding:6px 10px;text-align:left">날짜</th><th style="padding:6px 10px">표본</th>
        <th style="padding:6px 10px">언급률</th><th style="padding:6px 10px">인용률</th>
        <th style="padding:6px 10px">추천률</th><th style="padding:6px 10px">전대비</th>
      </tr></thead>
      <tbody>${histRows}</tbody>
    </table>`;
}

async function main(): Promise<void> {
  const nowIso = process.env["REPORT_STAMP"] ?? "";
  const sections: string[] = [];
  let headlineBits: string[] = [];
  for (const c of CUSTOMERS) {
    const db = getDb();
    const cust = await db.selectFrom("customer").select("id").where("slug", "=", c.slug).executeTakeFirst();
    if (!cust) {
      sections.push(`<h2>${c.name}</h2><p style="color:#888">고객 미등록</p>`);
      continue;
    }
    const pts = await pointsFor(cust.id);
    const pages = await pageCount(c.hub);
    const engines = await enginesFor(cust.id);
    sections.push(customerSection(c, pts, pages, engines));
    if (pts.length > 0) {
      const latest = pts[pts.length - 1]!;
      const denom = latest.judged > 0 ? latest.judged : latest.nTotal;
      headlineBits.push(`${c.name} 언급률 ${fmtPct(pct(latest.mention, denom))}`);
    }
  }

  const subject = `AEO/GEO 리포트${nowIso ? ` — ${nowIso.slice(0, 10)}` : ""} — ${headlineBits.join(" · ") || "측정 대기"}`;
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,'Malgun Gothic',sans-serif;color:#1a1a1a;max-width:720px;margin:0 auto;padding:20px">
  <h1 style="font-size:20px;margin:0 0 4px">AEO/GEO 최적화 리포트</h1>
  <p style="color:#666;font-size:13px;margin:0 0 6px">${nowIso ? nowIso.slice(0, 16).replace("T", " ") + " UTC · " : ""}측정된 AI 답변 모델에서의 브랜드 노출(언급→인용→추천)을 추적합니다. 각 고객 제목 옆에 실제 측정한 엔진을 표기합니다. 각 지표는 판정된 응답 대비 비율이며 95% 신뢰구간을 함께 표시합니다. "전대비"는 직전 측정 대비 변화(pt)입니다.</p>
  ${sections.join("\n")}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0 10px">
  <p style="color:#999;font-size:12px">자동 발송 · 게이트(§7) 통과 콘텐츠만 발행 · 측정 데이터 기반. 지표가 0%인 것은 아직 해당 AI 모델 답변에 브랜드가 등장하지 않았다는 뜻이며, 발행 콘텐츠가 크롤링·색인되며 상승하는지 매 사이클 추적합니다. "전대비" 변화는 AI 생태계 전반의 변동(모델 업데이트 등)을 통제하지 않은 관측값이며, 매주 단일 시점 측정이므로 유의미한 주만 선별하지 마세요.</p>
</body></html>`;

  await fs.writeFile("report-email.html", html, "utf8");
  // Trailing newline REQUIRED: the CI heredoc `cat report-subject.txt; echo "__EOF__"`
  // needs the subject on its own line, else __EOF__ concatenates onto it and the
  // GITHUB_ENV multiline delimiter is "not found" (the email step fails).
  await fs.writeFile("report-subject.txt", subject + "\n", "utf8");
  console.log(`[email-report] wrote report-email.html + report-subject.txt (to=${REPORT_TO})`);
  console.log(`[email-report] subject: ${subject}`);

  // Optional direct send via Resend when configured (else the workflow mails the files).
  if (process.env["RESEND_API_KEY"]) {
    const { ResendSink } = await import("../src/report/deliverySink.js");
    const sink = new ResendSink(process.env["RESEND_API_KEY"]!, process.env["REPORT_FROM"] ?? "onboarding@resend.dev");
    await sink.send({ to: REPORT_TO, subject, html, text: subject });
    console.log(`[email-report] sent via Resend to ${REPORT_TO}`);
  }
}

main()
  .catch((e) => { console.error("email-report failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
