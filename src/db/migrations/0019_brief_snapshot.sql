-- 0019_brief_snapshot.sql
--
-- Track 2 — persist the FULL diagnosed BrandBrief on the industry_template row.
--
-- Until now assembleTemplate only stored 4 scalar briefSnapshot fields
-- (brandName/category/positioning/industryKey) inside each question's JSONB.
-- That dropped productAttributes (the claim_source seed) and detectedLanguages
-- (the multilingual content matrix), so gen-content fell back to en-only,
-- generic, claim-less content.
--
-- This column carries the complete BrandBrief object (brandName, brandAliases,
-- category, industryKey, positioning, icp, productAttributes, seedCompetitors,
-- detectedLanguages, confidence) so gen-content's briefFromTemplate can rebuild
-- the real brief: multilingual + claim-seeding.
--
-- Additive + nullable: existing rows keep brief_snapshot=NULL and gen-content
-- transparently falls back to the legacy scalar reconstruction.

ALTER TABLE industry_template
  ADD COLUMN IF NOT EXISTS brief_snapshot jsonb;
