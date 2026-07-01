# config/content-terms — Controlled Vocabulary Files

## Purpose

Each `<lang>.json` file defines two controlled vocabulary lists for the §7
guardrail gates in Phase 2 content generation:

- **`superlatives`**: Unbounded marketing terms (superlatives, absolute claims)
  that must be backed by a verifiable `ClaimRecord` with a `resolved_source_id`
  before they can appear in a content asset. Used by `verifiableNumbersGate`
  (§7#2) and `jsonLdShapeGate`. If a superlative term from this list appears in
  an asset body without a sourced claim, the gate **blocks** the asset.

- **`disclosure_tags`**: Allowed sponsored / affiliation disclosure strings for
  that language. When a content asset targets a channel class in
  `{pr_wire, directory, web2, social}`, its `disclosure_tag` field MUST be a
  non-null value from this list. Used by `disclosureGate` (§7#6).

## Maintenance Liability

**These lists are a tracked maintenance liability.** They must be reviewed and
updated whenever:

1. New per-language marketing conventions emerge (e.g., a new superlative
   idiom common in K-beauty or the skincare category).
2. Platform or regulatory disclosure requirements change (e.g., FTC, ASA,
   Korea FTC 추천·보증 고시, Japan Stealth Marketing Act).
3. A new language is added to the system (a new `<lang>.json` MUST be created
   before generation for that language is enabled).

Assign language-specific review to a native speaker; do not rely solely on
translation tooling to judge whether a term is "superlative" in context.

## Schema

Each file must validate against the following Zod schema (enforced at runtime
by `src/content/index.ts` loaders):

```typescript
z.object({
  superlatives: z.array(z.string()),
  disclosure_tags: z.array(z.string()),
})
```

## NOT Reused: `questionGuards.SUPERLATIVE_PATTERNS`

The existing `src/generate/questionGuards.ts` exports `SUPERLATIVE_PATTERNS`
(a regex list used for question-generation guardrails). That export is:

1. **Module-private in spirit** — it guards question quality, not content claims.
2. **English-only** — it has no per-language variants.

The per-language superlative tables here are **entirely separate** and serve a
different §7 gate. Do NOT import or reuse `SUPERLATIVE_PATTERNS` in the content
gates.

## Current Languages

| File    | Language | Script           | Status  |
|---------|----------|------------------|---------|
| en.json | English  | Latin            | Seeded  |
| ko.json | Korean   | Hangul           | Seeded  |
| ja.json | Japanese | Hiragana/Katakana/Kanji | Seeded |

Additional languages (zh, fr, de, es, pt, ar, th, vi, tl, id, ru, it, nl, tr)
must be added before enabling generation for those languages.
