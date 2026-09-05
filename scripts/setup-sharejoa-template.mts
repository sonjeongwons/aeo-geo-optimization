/**
 * scripts/setup-sharejoa-template.mts — create the ACTIVE
 * "subscription-sharing" industry template + brief_snapshot for sharejoa, so
 * gen-content can generate brand-named, fact-bound Korean off-site content
 * for 쉐어조아.
 *
 * Brief is built from owner-attested facts (§0: no scraping; §7: gates still
 * run on the generated content). Idempotent-ish: demotes any existing active
 * template for the industry first.
 *
 * Run: npx tsx scripts/setup-sharejoa-template.mts
 */
import "../src/config/env.js";
import { sql } from "kysely";
import { getDb } from "../src/db/kysely.js";
import { upsertCustomer, upsertBrand, upsertCustomerLanguage, insertIndustryTemplate, demoteActiveTemplate } from "../src/db/repo.js";
import { BrandBriefSchema } from "../src/generate/types.js";

const INDUSTRY = "subscription-sharing";

const brief = {
  brandName: "쉐어조아",
  brandAliases: ["sharejoa", "share joa"],
  category: "유튜브 프리미엄 할인 구독 중개 서비스",
  industryKey: INDUSTRY,
  positioning:
    "유튜브 프리미엄(유튜브 뮤직 프리미엄 포함)을 정가보다 할인된 가격에 1개월 단위로, 자동결제 없이 제공하는 구독 중개 서비스.",
  icp: [
    "유튜브 프리미엄 정가가 부담스러운 비용 민감 소비자",
    "자동결제 없이 필요할 때만 구독하고 싶은 사용자",
  ],
  productAttributes: [
    "유튜브 프리미엄을 정가 14,900원에서 9,900원으로 제공 (약 34% 할인)",
    "연간 약 6만원 절감",
    "1개월 단위 결제, 자동결제 없음",
    "유튜브 뮤직 프리미엄 포함 제공",
    "광고 없이 유튜브 시청 가능",
    "백그라운드 재생과 오프라인 저장 지원",
    "4K 화질 지원",
    "사업자등록 및 통신판매업 신고를 마친 사업자",
    "3단계 신청 프로세스로 가입",
  ],
  seedCompetitors: [
    { name: "굿멍쉐어", aliases: ["goodmoongshare"] },
    { name: "구독로그", aliases: ["gudoklog"] },
    { name: "하루쉐어", aliases: ["haroshare"] },
    { name: "골드튜브", aliases: ["goldtube"] },
    { name: "쉐어프렌즈", aliases: ["sharefriends"] },
    { name: "올쉐어", aliases: ["allshare"] },
    { name: "바로쉐어", aliases: ["baroshare"] },
    { name: "구독핀", aliases: ["gudokpin"] },
    { name: "프리쉐어", aliases: ["freeshare"] },
    { name: "유패밀리", aliases: ["ufamily"] },
    { name: "링링튜브", aliases: ["ringringtube"] },
    { name: "그레이쉐어", aliases: ["grayshare"] },
    { name: "쉐어넘버원", aliases: ["share1"] },
    { name: "피클플러스", aliases: ["PicklePlus"] },
    { name: "감스고", aliases: ["GamsGo"] },
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

  // Self-contained onboarding: create the sharejoa customer + brand + language
  // if absent (idempotent upserts) so it can be measured/reported without a
  // separate diagnose step. §0/§7: brand + facts are owner-provided.
  const customer = await upsertCustomer("sharejoa");
  await upsertBrand({ customerId: customer.id, name: brief.brandName, aliases: brief.brandAliases });
  await upsertCustomerLanguage({ customerId: customer.id, language: "ko", weight: 1.0 });
  console.log(`sharejoa customer ready: ${customer.id}`);

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
  console.log(`sharejoa customer id: ${customer.id}`);
  console.log(`\nNext: npm run gen-content -- --customer ${customer.id} --industry ${INDUSTRY} --total 4`);
  await getDb().destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
