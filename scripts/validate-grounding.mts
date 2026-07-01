/**
 * scripts/validate-grounding.mts — minimal end-to-end validation of the grounding
 * → earned-source → engine-overlap pipeline on ONE real grounded Gemini call.
 *
 * Cost: ~1 Gemini generate call WITH the Google Search grounding tool (billed).
 * §0: queries a general MARKET question — never the customer/competitor domain —
 * and reads only the URLs the engine itself returns. No DB writes.
 *
 * Run: npx tsx scripts/validate-grounding.mts
 */
import "../src/config/env.js";
import { buildRegistry } from "../src/providers/registry.js";
import { computeGroundingGap, type GroundingTrace } from "../src/judge/groundingGap.js";
import { aggregateEarnedSources, type ResponseSourceSignal } from "../src/metrics/earnedSources.js";
import { computeEngineOverlap } from "../src/metrics/engineOverlap.js";

const QUERY =
  "What are the best AI character chat apps with long-term memory and image generation in 2026?";

async function main() {
  const registry = buildRegistry();
  const gemini = registry.get("gemini");
  if (!gemini || gemini.status !== "ready") {
    console.error("gemini adapter not ready — is GEMINI_API_KEY set?");
    process.exit(1);
  }

  console.log("→ calling Gemini generate() with grounded=true …\n");
  const res = await gemini.generate({
    prompt: QUERY,
    modelId: "gemini-2.5-flash",
    temperature: 0.2,
    promptVersion: "validate-grounding-v1",
    language: "en",
    grounded: true,
  });

  if (!res.ok) {
    console.error("generate failed:", res.code, res.message ?? "");
    process.exit(1);
  }

  const meta = res.meta as { grounding?: GroundingTrace } | undefined;
  const grounding = meta?.grounding;
  console.log("answerText (first 240 chars):");
  console.log("  " + res.answerText.slice(0, 240).replace(/\n/g, " ") + "…\n");

  if (!grounding) {
    console.error("✗ NO grounding trace on meta — grounding did not populate.");
    console.error("  (Check that the model supports the googleSearch tool and the key has it enabled.)");
    process.exit(2);
  }

  console.log("✓ grounding trace present:");
  console.log("  webSearchQueries:", JSON.stringify(grounding.webSearchQueries));
  console.log("  chunks:", grounding.chunks.length, "supports:", grounding.supports.length);

  const gap = computeGroundingGap(grounding);
  console.log("\n✓ computeGroundingGap:");
  console.log("  fetchedDomains:", gap.fetchedDomains);
  console.log("  citedDomains :", gap.citedDomains);
  console.log("  gapDomains   :", gap.gapDomains, "(fetched-but-not-cited)");
  console.log("  P(cited|fetched):", gap.pCitedGivenFetched);

  const signal: ResponseSourceSignal = {
    citedDomains: gap.citedDomains,
    fetchedDomains: gap.fetchedDomains,
    brandMentioned: /emora/i.test(res.answerText),
    modelId: "gemini-2.5-flash",
  };
  const corpus = aggregateEarnedSources([signal]);
  console.log("\n✓ earned-source corpus (n=1 response):");
  for (const d of corpus.domains.slice(0, 12)) {
    console.log(`  ${d.domain} — cited ${d.citedResponses}, fetched ${d.fetchedResponses}, brandCoCited ${d.brandCoCitedResponses}`);
  }

  const overlap = computeEngineOverlap([signal]);
  console.log("\n✓ engineOverlap (1 engine → no pairs, honest):");
  console.log("  engines:", overlap.engines, "pairs:", overlap.pairs.length, "meanJaccard:", overlap.meanJaccard);

  console.log("\n=== VALIDATION OK: grounding → earned-source → engineOverlap pipeline produces real data. ===");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
