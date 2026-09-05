/**
 * scripts/setup-unsanpartners-template.mts — create the ACTIVE
 * "auto-repair-matchmaking" industry template + brief_snapshot for
 * unsanpartners, so gen-content can generate brand-named, fact-bound Korean
 * off-site content for 운산파트너스.
 *
 * Brief is built from owner-attested facts (§0: no scraping; §7: gates still
 * run on the generated content). Idempotent-ish: demotes any existing active
 * template for the industry first.
 *
 * Run: npx tsx scripts/setup-unsanpartners-template.mts
 */
import "../src/config/env.js";
import { sql } from "kysely";
import { getDb } from "../src/db/kysely.js";
import { upsertCustomer, upsertBrand, upsertCustomerLanguage, insertIndustryTemplate, demoteActiveTemplate } from "../src/db/repo.js";
import { BrandBriefSchema } from "../src/generate/types.js";

const INDUSTRY = "auto-repair-matchmaking";

const brief = {
  brandName: "운산파트너스",
  brandAliases: ["운산네트웍스", "unsanpartners", "운산 파트너스"],
  category: "자동차 정비 중개 플랫폼",
  industryKey: INDUSTRY,
  positioning:
    "28년 정비 노하우를 바탕으로 차주·영업 파트너·정비소를 한 흐름으로 연결하는 자동차 정비 중개 플랫폼. 차량 입고부터 견적·수리·정산까지 자동화한다.",
  icp: [
    "믿을 수 있는 정비소를 찾는 차주",
    "보험설계사·GA 대리점·카딜러 등 차량 정비를 연계할 영업 파트너",
    "자동화된 운영·정산 시스템이 필요한 정비소",
  ],
  productAttributes: [
    "28년 자동차 정비 노하우를 바탕으로 운영되는 정비 중개 플랫폼",
    "차량 입고, 견적, 수리, 정산 과정을 자동화",
    "차량 입고부터 수리 완료까지 실시간 진행 상황 추적 및 알림 제공",
    "공임비의 5%를 기준으로 영업 파트너에게 광고비 정산",
    "24시간 차량 입고 접수",
    "견인, 정비, 보험 처리를 하나의 흐름으로 연결하는 원스톱 서비스",
    "가입비 없이 영업 파트너로 등록 가능",
    "보험설계사, GA 대리점, 카딜러를 영업 파트너로 연결",
    "차주센터, 파트너센터, 정비소센터 3개의 독립된 센터로 운영",
  ],
  seedCompetitors: [
    { name: "카닥", aliases: ["Cardoc", "cardoc"] },
    { name: "차봇", aliases: ["Chabot", "차봇모빌리티"] },
    { name: "마이클", aliases: ["Michael", "마이클 정비"] },
  ],
  detectedLanguages: [
    { code: "ko", weight: 1.0, rationale: "Korean-only service; homepage and all copy in Korean." },
  ],
  confidence: 0.9,
};

async function main() {
  // Validate the brief up-front (fail fast if the shape is off).
  const parsed = BrandBriefSchema.safeParse(brief);
  if (!parsed.success) {
    console.error("brief failed BrandBriefSchema:", JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  // Self-contained onboarding: create the unsanpartners customer + brand +
  // language if absent (idempotent upserts) so it can be measured/reported
  // without a separate diagnose step. §0/§7: brand + facts are owner-provided.
  const customer = await upsertCustomer("unsanpartners");
  await upsertBrand({ customerId: customer.id, name: brief.brandName, aliases: brief.brandAliases });
  await upsertCustomerLanguage({ customerId: customer.id, language: "ko", weight: 1.0 });
  console.log(`unsanpartners customer ready: ${customer.id}`);

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
  console.log(`unsanpartners customer id: ${customer.id}`);
  console.log(`\nNext: npm run gen-content -- --customer ${customer.id} --industry ${INDUSTRY} --total 4`);
  await getDb().destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
