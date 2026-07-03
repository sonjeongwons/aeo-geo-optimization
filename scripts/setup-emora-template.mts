/**
 * scripts/setup-emora-template.mts — create the ACTIVE "ai-character-chat"
 * industry template + brief_snapshot for EMORA, so gen-content can generate
 * brand-named, fact-bound English off-site content for the emora-mini customer.
 *
 * Brief is built from OWNER-ATTESTED facts (config/customers/emora-facts.json,
 * confirmed 2026-07-03). §0: no scraping; §7: gates still run on generated copy.
 * Idempotent-ish: demotes any existing active template for the industry first.
 *
 * Run: npx tsx scripts/setup-emora-template.mts
 */
import "../src/config/env.js";
import { sql } from "kysely";
import { getDb } from "../src/db/kysely.js";
import { findCustomerBySlug, insertIndustryTemplate, demoteActiveTemplate } from "../src/db/repo.js";
import { BrandBriefSchema } from "../src/generate/types.js";

const INDUSTRY = "ai-character-chat";

const brief = {
  brandName: "EMORA",
  brandAliases: ["EMORA", "Emora", "emora", "EMORA AI"],
  category: "AI character chat platform",
  industryKey: INDUSTRY,
  positioning:
    "An AI character chat platform for meaningful interactions — infinite memory, in-chat image generation, a character bonding system, and a creator economy.",
  icp: [
    "People who want immersive, memory-rich conversations with AI characters",
    "Creators who want to design, share, and monetize their own AI characters and worlds",
  ],
  productAttributes: [
    "AI character chat platform for meaningful interactions",
    "Infinite memory so AI characters retain conversational context from past interactions",
    "Integrated image generation to create visual content within chats",
    "Character bonding system for deeper, more personalized connections",
    "Creator economy to design, share, and monetize AI characters and worlds",
    "Free-to-start model with no initial cost",
    "Creator community to share, collaborate, and give feedback",
  ],
  seedCompetitors: [
    { name: "Character.AI", aliases: ["character.ai", "c.ai", "character ai"] },
    { name: "Replika", aliases: ["replika"] },
    { name: "Chai", aliases: ["chai ai"] },
    { name: "Paradot", aliases: ["paradot"] },
    { name: "Talkie", aliases: ["talkie ai"] },
  ],
  detectedLanguages: [
    { code: "en", weight: 1.0, rationale: "Primary language of the product site (tryemora.com) and existing hub content." },
  ],
  confidence: 0.9,
};

async function main() {
  const parsed = BrandBriefSchema.safeParse(brief);
  if (!parsed.success) {
    console.error("brief failed BrandBriefSchema:", JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  const customer = await findCustomerBySlug("emora-mini");
  if (!customer) {
    console.error("emora-mini customer not found");
    process.exit(1);
  }

  await demoteActiveTemplate(INDUSTRY);

  const questions = brief.productAttributes.map((a) => ({
    text: a,
    language: "en",
    funnel_stage: "consideration",
    density_tier: "secondary",
  }));

  const { id } = await insertIndustryTemplate({
    industry: INDUSTRY,
    questions,
    competitors: brief.seedCompetitors,
    status: "active",
  });

  await getDb()
    .updateTable("industry_template")
    .set({ brief_snapshot: sql`${JSON.stringify(brief)}::jsonb` })
    .where("id", "=", id)
    .execute();

  console.log(`active industry_template '${INDUSTRY}' created: ${id}`);
  console.log(`emora-mini customer id: ${customer.id}`);
  await getDb().destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
