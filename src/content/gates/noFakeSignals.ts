/**
 * src/content/gates/noFakeSignals.ts
 *
 * T11 — noFakeSignalsGate (§7#3): STRUCTURAL belt-and-suspenders check.
 *
 * DESIGN-phase2.md §"THE FIVE GATES":
 *   STRUCTURAL: community/review channel_class is NOT in the enum so it cannot
 *   be generated (structural §7#3 exclusion at the type level).  Also blocks:
 *   - review/testimonial/vote-count scaffolding patterns in body text.
 *   - any usage-count claim that lacks a resolved_source_id in claims[].
 *
 * §7#3: "가짜 신호 금지" — no fake reviews, disguised community posts, or
 * vote-count claims.  The channel_class enum already excludes 'community' and
 * 'review', so this gate adds a belt-and-suspenders text scan.
 *
 * Patterns blocked:
 *   - "X reviews", "X ratings", "X votes", "X users rated", "X stars" (where X
 *     is a number) with no resolved source.
 *   - Fake testimonial scaffolding: "customers say", "users love", "people love",
 *     "loved by X" with no resolved source.
 *   - Vote/community engagement metrics: "X upvotes", "X likes", "trending",
 *     "viral", "community favorite" with no resolved source.
 *
 * "No resolved source" means: asset.claims has no ClaimRecord whose claim_text
 * contains the pattern AND resolved_source_id != null.
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * Regex patterns for fake review/testimonial/vote-count scaffolding.
 * All patterns are case-insensitive.
 */
const FAKE_SIGNAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Numeric review/rating counts ("5,000 reviews", "10K ratings")
  {
    name: "review-count",
    pattern: /\b\d[\d,]*(?:k|m|million|thousand)?\s*(?:reviews?|ratings?|votes?|verified reviews?)\b/i,
  },
  // Numeric user/customer counts tied to ratings ("X users rated", "X customers")
  {
    name: "user-rating-count",
    pattern: /\b\d[\d,]*(?:k|m|million|thousand)?\s*(?:users?|customers?|people)\s+(?:rated|reviewed|voted|love|loved|trust|trusted)\b/i,
  },
  // Star ratings out of X ("4.8 stars", "4.8/5 stars")
  {
    name: "star-rating",
    pattern: /\b\d+(?:\.\d+)?\s*(?:\/\s*5|\/\s*10)?\s*stars?\b/i,
  },
  // Community/social engagement metrics
  {
    name: "upvote-count",
    pattern: /\b\d[\d,]*(?:k|m|million|thousand)?\s*(?:upvotes?|likes?|shares?)\b/i,
  },
  // Testimonial scaffolding phrases
  {
    name: "testimonial-scaffold",
    pattern: /\b(?:customers?|users?|people|members?)\s+(?:say|love|trust|recommend|swear by|rave about)\b/i,
  },
  // "community favorite", "loved by users", "trending" without source
  {
    name: "community-signals",
    pattern: /\b(?:community\s+favorite|loved\s+by|trending|viral|word\s+of\s+mouth|social\s+proof)\b/i,
  },
  // "Award-winning" without a specific award in a resolved source
  // Not blocked here because it's typically superlative — caught by verifiableNumbers.
  // We leave "award-winning" for verifiableNumbers so this gate focuses on fake-signal patterns.

  // ---- Korean fake-signal patterns (W1.9) — no \b word boundaries in CJK ----
  // review/rating counts: "1,200개 리뷰", "후기 340개", "평점 4.8"
  { name: "ko-review-count", pattern: /\d[\d,]*\s*(?:개[의]?\s*)?(?:리뷰|후기|평점|별점|사용후기|이용후기)/ },
  { name: "ko-star-rating", pattern: /(?:별점|평점)\s*\d(?:\.\d+)?/ },
  // social proof: "5만 명이 추천", "1000명의 회원이 애용"
  { name: "ko-social-proof", pattern: /\d[\d,]*\s*(?:만|억)?\s*명(?:의)?\s*(?:회원|사용자|고객|이용자)?\s*(?:이|가|은|들이)?\s*(?:추천|애용|사랑|신뢰|극찬|만족)/ },
  // engagement metrics: "1.2만 좋아요", "조회수 5만"
  { name: "ko-engagement", pattern: /(?:좋아요|조회수|공유|찜|팔로워)\s*\d|\d[\d,]*\s*(?:만|억)?\s*(?:좋아요|조회수|공유|찜|팔로워)/ },
  // testimonial scaffolding: "고객들이 추천합니다", "사용자가 극찬"
  { name: "ko-testimonial", pattern: /(?:고객|사용자|회원|이용자)(?:들)?(?:이|은|께서)?\s*(?:말합니다|추천합니다|사랑합니다|극찬|만족합니다|호평)/ },
  { name: "ko-community", pattern: /입소문|커뮤니티\s*인기|소셜\s*증거/ },

  // ---- Japanese fake-signal patterns (W1.9) ----
  { name: "ja-review-count", pattern: /\d[\d,]*\s*(?:件[の]?\s*)?(?:レビュー|口コミ|評価数)/ },
  { name: "ja-star-rating", pattern: /星\s*\d(?:\.\d+)?|\d(?:\.\d+)?\s*つ星|評価\s*\d(?:\.\d+)?/ },
  { name: "ja-social-proof", pattern: /\d[\d,]*\s*(?:万|億)?\s*人(?:が|の|に)\s*(?:推薦|愛用|絶賛|支持|満足)/ },
  { name: "ja-engagement", pattern: /\d[\d,]*\s*(?:万|億)?\s*(?:いいね|シェア|フォロワー|再生)/ },
  { name: "ja-testimonial", pattern: /(?:お客様|ユーザー|会員)(?:の声)?(?:が|は|も)?\s*(?:絶賛|愛用|推薦|満足|支持)/ },
  { name: "ja-community", pattern: /口コミで話題|人気沸騰|バズ/ },
];

// ---------------------------------------------------------------------------
// Body text extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a content asset body for fake-signal scanning.
 * Covers all prose content.
 */
function extractBodyTextForScan(asset: ContentAsset): string {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;

    case "answer_block":
      return body.text;

    case "faq":
      return body.rows.map((r) => `${r.q} ${r.a}`).join(" ");

    case "comparison": {
      const cols = body.columns.join(" ");
      const rows = body.rows
        .map((r) => `${r.entity} ${r.cells.map((c) => c.value).join(" ")}`)
        .join(" ");
      return `${cols} ${rows}`;
    }

    case "case_study":
      return [body.situation, body.action, body.result].join(" ");

    case "jsonld":
      try {
        return JSON.stringify(body.json);
      } catch {
        return "";
      }
  }
}

// ---------------------------------------------------------------------------
// noFakeSignalsGate
// ---------------------------------------------------------------------------

/**
 * noFakeSignalsGate (§7#3)
 *
 * STRUCTURAL belt-and-suspenders check.  The channel_class enum already
 * structurally excludes 'community' and 'review' channel classes.  This gate
 * adds a text-level scan for patterns that would constitute fake social signals:
 * review counts, testimonial scaffolding, and vote/engagement metrics.
 *
 * If a pattern match is found AND no corresponding ClaimRecord with
 * resolved_source_id != null covers it, the asset is BLOCKED.
 *
 * "Covered" = at least one claim in claims[] has:
 *   - resolved_source_id != null (source attached and verified/pending sign-off)
 *   - claim_text that overlaps with the matched text (heuristic containment)
 *
 * If claims[] is empty (pre-extraction), ALL pattern hits → BLOCK.
 */
export const noFakeSignalsGate = {
  name: "noFakeSignalsGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset } = ctx;
    const bodyText = extractBodyTextForScan(asset);

    if (bodyText.trim().length === 0) {
      return { action: "pass", gate: "noFakeSignalsGate" };
    }

    // Build set of claim texts with resolved sources for coverage check.
    // §7 INVARIANT (W1.1 P2): resolved_source_id-only is safe ONLY while the
    // binder (claimVerificationGate) runs LAST; W1.2 reordering MUST switch this
    // to isClaimVerified() (see claimVerify.ts).
    const resolvedClaimTexts = asset.claims
      .filter((c) => c.resolved_source_id !== null)
      .map((c) => c.claim_text.toLowerCase());

    const violations: string[] = [];

    for (const { name, pattern } of FAKE_SIGNAL_PATTERNS) {
      const matches = bodyText.match(pattern);
      if (matches === null) continue;

      const matchedText = matches[0]!.toLowerCase();

      // Check if any resolved claim covers this match
      const covered = resolvedClaimTexts.some(
        (ct) => ct.includes(matchedText) || matchedText.includes(ct)
      );

      if (!covered) {
        violations.push(
          `Pattern "${name}" matched: "${matches[0]!}" — no resolved claim_source covers this.`
        );
      }
    }

    if (violations.length > 0) {
      return {
        action: "block",
        gate: "noFakeSignalsGate",
        reason:
          `§7#3 fake-signal pattern(s) detected without verified source: ` +
          violations.join(" | "),
      };
    }

    return { action: "pass", gate: "noFakeSignalsGate" };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};
