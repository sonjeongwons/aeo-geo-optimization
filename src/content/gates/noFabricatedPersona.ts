/**
 * src/content/gates/noFabricatedPersona.ts
 *
 * W4 (SOTA sweep v4) — noFabricatedPersonaGate: STRUCTURAL FTC fake-endorsement
 * guardrail. Complements noFakeSignalsGate (§7#3, which catches review/vote/
 * rating COUNTS) by catching the OTHER FTC fake-endorsement vector: invented
 * people and first-person testimonial voice in AUTO-GENERATED owned-net content.
 *
 * Why this is its own gate (regulation-forward, §7-aligned):
 *   The FTC's Endorsement Guides + the 2024 "fake reviews and testimonials" rule
 *   (16 CFR Part 465) prohibit fabricated endorsements, invented consumer
 *   personas, and testimonials that misrepresent a real person's experience.
 *   Because THIS platform's content is AI-generated, any first-person endorsement
 *   ("I love it", "my experience with EMORA") or named-persona testimonial
 *   ("Sarah, a 32-year-old marketer, says …") is, by construction, fabricated —
 *   no real endorser stands behind it. So we BLOCK those patterns structurally.
 *
 * What is NOT blocked (precision guards — these are legitimate AEO content):
 *   - First-person QUESTIONS in FAQ/answer copy ("How do I cancel?", "Can I
 *     export my data?") — the user's voice asking, not a testimonial. We only
 *     fire on first-person ENDORSEMENT verbs, never on interrogatives.
 *   - Second-person instructional voice ("you can configure …").
 *   - Third-person factual product description ("EMORA supports group chat").
 *   - JSON-LD bodies (structured data; author/review fields are W3's province).
 *
 * Tri-lingual (en / ko / ja) to match the platform's KR/JP reach, mirroring the
 * negation-cue approach in claimVerify.ts.
 *
 * PURE: no I/O, no LLM, no network. Deterministic. Block-only on a match.
 *
 * Node 22 ESM NodeNext — relative imports use the .js extension.
 */

import type {
  ContentAsset,
  ContentGateContext,
  ContentGateResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fabricated-persona / first-person-testimonial patterns
// ---------------------------------------------------------------------------

/**
 * Each pattern is high-precision: designed to fire ONLY on fabricated-endorsement
 * scaffolding, not on legitimate factual or instructional copy. Case-insensitive
 * where the language is cased (the CJK patterns are caseless by nature).
 */
const PERSONA_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // ---- English ----------------------------------------------------------
  // First-person singular endorsement verbs: "I love", "I've been using",
  // "I switched to", "I tried", "I recommend", "I rely on". NOT interrogative
  // ("do I", "can I", "should I" are excluded by requiring the verb to FOLLOW
  // the pronoun directly).
  {
    name: "first-person-endorsement",
    pattern:
      /\bI(?:'ve|'m| have| had| am)?\s+(?:love|loved|adore|use|used|using|tried|switched|recommend|prefer|trust|rely|subscribed|signed up|been using|can't live without|highly recommend)\b/i,
  },
  // First-person possessive testimonial: "my experience with", "my favorite",
  // "my go-to", "in my opinion this", "my team loves".
  {
    name: "first-person-possessive-testimonial",
    pattern:
      /\bmy\s+(?:experience\s+(?:with|using)|favou?rite|go-to|results\s+with|team\s+(?:loves|loved|uses)|honest\s+(?:opinion|review))\b/i,
  },
  // "As a [happy/longtime/satisfied] user/customer/fan" — self-styled endorser.
  {
    name: "self-styled-endorser",
    pattern:
      /\bas\s+(?:a|an)\s+(?:long-?time|happy|satisfied|loyal|delighted|avid|former)\s+(?:user|customer|client|fan|subscriber)\b/i,
  },
  // Fabricated demographic persona: "Sarah, a 32-year-old marketer", "Mike, a
  // small-business owner". Capitalized given name + ", a/an [optional age] role".
  {
    name: "fabricated-demographic-persona",
    pattern:
      /\b[A-Z][a-z]+(?:\s+[A-Z]\.?)?,\s+(?:a|an)\s+(?:\d{1,2}[-\s]?year[-\s]?old\s+)?[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}\s*,?\s*(?:says?|said|shares?|told us|explains?|recalls?)\b/,
  },
  // "Meet our customer Mike" — explicit fabricated-customer framing. Keyword is
  // case-insensitive ([Mm]eet) but the name stays strict-capitalized (no /i flag).
  {
    name: "intro-persona-customer",
    pattern: /\b[Mm]eet\s+our\s+(?:customer|user|client)s?\s+[A-Z][a-z]+\b/,
  },
  // "Meet Sarah," / "Meet Sarah says…" — a bare named-person intro, but ONLY when
  // the name is immediately followed by a comma/period or a testimonial verb, so
  // benign "Meet <Capitalized noun>" copy ("Meet Slack integration", "Meet
  // European compliance standards") is NOT blocked (sweep v6 Y6).
  {
    name: "intro-persona-named",
    pattern: /\b[Mm]eet\s+[A-Z][a-z]+(?=\s*[,.]|\s+(?:says?|shares?|loves?|tried|recommends?|recalls?|explains?))/,
  },
  // Attributed testimonial quote: a quoted sentence followed by an em-dash/hyphen
  // and a capitalized attributed name ("…changed everything." — Sarah M.).
  {
    name: "attributed-quote-testimonial",
    pattern: /["“][^"”]{15,}["”]\s*[—–-]\s*[A-Z][a-z]+/,
  },
  // Spokesperson / brand-ambassador invention.
  {
    name: "invented-spokesperson",
    pattern:
      /\b(?:our|brand)\s+(?:spokesperson|ambassador|advocate|evangelist)\b/i,
  },

  // ---- Korean (ko) ------------------------------------------------------
  // First-person endorsement: "제가 …써보니/사용해보니", "저는 …추천합니다",
  // "내 경험상", "제 경험으로는". 저/제/내 (I/my) + endorsement context.
  {
    name: "ko-first-person-endorsement",
    pattern:
      /(?:제가|저는|저도|내가)\s*[^.!?\n]{0,20}(?:써보니|사용해\s*보니|사용해본|추천(?:합니다|해요|드려요|드립니다)|만족(?:합니다|해요)|애용)/,
  },
  {
    name: "ko-first-person-experience",
    pattern: /(?:제|내)\s*경험(?:상|으로(?:는)?|에)/,
  },

  // ---- Japanese (ja) ----------------------------------------------------
  // First-person endorsement: "私は…使ってみました/おすすめします", "私の経験では".
  {
    name: "ja-first-person-endorsement",
    pattern:
      /(?:私|僕|俺)(?:は|が|も)?[^。!?\n]{0,20}(?:使って(?:みました|います)|おすすめ(?:します|です)|愛用|満足)/,
  },
  {
    name: "ja-first-person-experience",
    pattern: /(?:私|僕)の経験(?:では|から|上)/,
  },
];

// ---------------------------------------------------------------------------
// Body text extraction (jsonld excluded — structured data is W3's province)
// ---------------------------------------------------------------------------

/**
 * Extract scannable prose from the asset body. Returns "" for jsonld (so the
 * gate passes structured data) — author/review FIELDS in JSON-LD are a separate
 * provenance concern (W3), not a fabricated-prose-testimonial concern.
 */
function extractProse(asset: ContentAsset): string {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;
    case "answer_block":
      return body.text;
    case "faq":
      return body.rows.map((r) => `${r.q} ${r.a}`).join(" ");
    case "comparison": {
      const rows = body.rows
        .map((r) => `${r.entity} ${r.cells.map((c) => c.value).join(" ")}`)
        .join(" ");
      return `${body.columns.join(" ")} ${rows}`;
    }
    case "case_study":
      return [body.situation, body.action, body.result].join(" ");
    case "jsonld":
      return "";
  }
}

// ---------------------------------------------------------------------------
// noFabricatedPersonaGate
// ---------------------------------------------------------------------------

/**
 * noFabricatedPersonaGate (W4 — FTC fake-endorsement guardrail)
 *
 * BLOCKs an asset whose prose contains a fabricated-persona or first-person
 * testimonial pattern. Because all content here is AI-generated, such patterns
 * cannot reflect a real endorser and are FTC fake-endorsement risk (16 CFR 465).
 *
 * Cheap structural gate (runs before the paid claimVerificationGate). Block-only;
 * collects ALL matched patterns for the §12 audit trail.
 */
export const noFabricatedPersonaGate = {
  name: "noFabricatedPersonaGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const prose = extractProse(ctx.asset);
    if (prose.trim().length === 0) {
      return { action: "pass", gate: "noFabricatedPersonaGate" };
    }

    const violations: string[] = [];
    for (const { name, pattern } of PERSONA_PATTERNS) {
      const m = prose.match(pattern);
      if (m !== null) {
        violations.push(`"${name}" matched: "${m[0]!.trim().slice(0, 60)}"`);
      }
    }

    if (violations.length > 0) {
      return {
        action: "block",
        gate: "noFabricatedPersonaGate",
        reason:
          `FTC fake-endorsement risk — fabricated persona / first-person ` +
          `testimonial voice in AI-generated content: ` +
          violations.join(" | "),
      };
    }

    return { action: "pass", gate: "noFabricatedPersonaGate" };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};
