/**
 * scripts/setup-smim-template.mts — create the ACTIVE "rotation-dating" industry
 * template + brief_snapshot for smim, so gen-content can generate brand-named,
 * fact-bound Korean off-site content for smimdate.
 *
 * Brief is built from owner-attested facts (§0: no scraping; §7: gates still run
 * on the generated content). Idempotent-ish: demotes any existing active template
 * for the industry first.
 *
 * Run: npx tsx scripts/setup-smim-template.mts
 */
import "../src/config/env.js";
import { sql } from "kysely";
import { getDb } from "../src/db/kysely.js";
import { findCustomerBySlug, insertIndustryTemplate, demoteActiveTemplate } from "../src/db/repo.js";
import { BrandBriefSchema } from "../src/generate/types.js";

const INDUSTRY = "rotation-dating";

const brief = {
  brandName: "스밈",
  brandAliases: ["SMIM", "smim", "스밈", "스밈데이트", "smimdate"],
  category: "로테이션 소개팅 서비스",
  industryKey: INDUSTRY,
  positioning:
    "검증된 회원만 참여하는 로테이션 소개팅. 결혼정보업체보다 부담이 적고 일반 소개팅보다 진중한 만남을 지향한다.",
  icp: [
    "연봉 7천만원 이상 전문직·대기업·공무원·금융권·사업가 종사자",
    "진지한 만남을 원하는 20대 후반~30대 미혼 직장인",
  ],
  productAttributes: [
    "검증된 회원만 참여하는 로테이션 소개팅",
    "매주 금·토·일 서울에서 진행, 참가비 1인 50,000원",
    "연봉 7천만원 이상 대상으로 회차 구성",
    "신청자의 직장·소득·신원·외모를 매니저가 직접 검수",
    "증빙 서류는 검수 직후 즉시 파기",
    "매칭된 커플에게 매니저가 카카오톡 대화방 개설",
    "소개팅 종료 후 전원에게 익명 기반 AI 분석 리포트 제공",
    "일반 카페·바가 아닌 전용 공간에서 진행",
    "미혼만 참석 가능",
    "AI 데이트 코칭·피드백 제공",
  ],
  seedCompetitors: [
    { name: "러브매칭", aliases: ["lovematching"] },
    { name: "미설", aliases: ["miseol"] },
    { name: "비긴즈", aliases: ["사람인 비긴즈"] },
    { name: "스카이피플", aliases: ["SkyPeople"] },
    { name: "정오의데이트", aliases: ["noondate"] },
  ],
  detectedLanguages: [
    { code: "ko", weight: 1.0, rationale: "Korean-only service; homepage and all copy in Korean." },
  ],
  confidence: 0.95,
};

async function main() {
  // Validate the brief up-front (fail fast if the shape is off).
  const parsed = BrandBriefSchema.safeParse(brief);
  if (!parsed.success) {
    console.error("brief failed BrandBriefSchema:", JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  const customer = await findCustomerBySlug("smimdate");
  if (!customer) {
    console.error("smimdate customer not found — run diagnose --customer smimdate first");
    process.exit(1);
  }

  // Demote any existing active template for this industry (partial unique index).
  await demoteActiveTemplate(INDUSTRY);

  const questions = brief.productAttributes.map((a) => ({
    text: a,
    language: "ko",
    funnel_stage: "consideration",
    density_tier: "secondary",
  }));

  const { id } = await insertIndustryTemplate({
    industry: INDUSTRY,
    questions,
    competitors: brief.seedCompetitors,
    status: "active",
  });

  // Attach the brief_snapshot (0019) so gen-content produces brand-named, KO content.
  await getDb()
    .updateTable("industry_template")
    .set({ brief_snapshot: sql`${JSON.stringify(brief)}::jsonb` })
    .where("id", "=", id)
    .execute();

  console.log(`active industry_template '${INDUSTRY}' created: ${id}`);
  console.log(`smimdate customer id: ${customer.id}`);
  console.log(`\nNext: npm run gen-content -- --customer ${customer.id} --industry ${INDUSTRY} --total 4`);
  await getDb().destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
