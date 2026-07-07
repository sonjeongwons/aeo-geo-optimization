---
name: reference-korean-claim-binding
description: "How Korean claim→source binding works in claimVerify (CJK tokenizer + stem match), and the open numeric gap"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
---

claimVerify.ts binds a generated claim to a signed claim_source via findMatchingSource: exact → contains (`srcNorm.includes(claimNorm)` — CJK-safe) → keyword-overlap ≥2/3 (tokenized).

**Fixed 2026-07-03:** tokenize() used `[^a-z0-9\s]` which DELETED all Hangul → CJK claims tokenized to [] and the overlap tier was dead for ko/ja. Now `[^\p{L}\p{N}\s]/gu` (Unicode) + `wordMatch()` does CJK **stem matching**: two CJK tokens match when their longest common prefix ≥2 chars (Korean is suffixing: 공간↔공간에서, 매니저가↔매니저의, 검수↔검수하여 share the stem; 직장↔직업 share only 1 char → no match). Bounded so fabricated claims still bind to nothing. Test: test/claimVerify-korean-stem.test.ts. Effect: smim owned_net pass 0→7.

**Numeric fixes DONE 2026-07-03 (commit df70bbc):**
- normalizeNumeric now canonicalizes currency aliases: 원/won/₩→krw, 만원×10^4, 억원×10^8, $/usd/dollar→usd. A claim in "원" binds to a KRW-stored source (was INCOMPATIBLE → blocked). Fixes 참가비 50,000원 / 연봉 7천만원 unit binding.
- numericDetect: removed single-char ratio units 배/할 (ko), 倍/割 (ja), 倍/成 (zh) from NUMBER_WORDS — they collided with common words (배=ship, 할=verb ending 확인할/구성할) → false-positive numeric BLOCKS on clean prose. Digit forms (2배,3할) still caught by DIGIT_REGEX. Test: test/numericDetect-cjk-ratio-falsepos.test.ts.
- generation prompt (commit dc793a5): added ko/ja superlative avoid-lists (철저/엄격/완벽/프리미엄/최선…) — the model was emitting Korean superlatives the §7 gate then blocked.

**Still OPEN:** "7천만" (Arabic digit + HANGUL multiplier 천만) → numericDetect only catches "7" (천만 is Hangul, not the CJK ideographs 千万 in CJK_NUMERAL_REGEX). Binding still works IF the LLM claim value covers the span, but detection is partial. Also incidental unsourced numbers (ages 20대/30대) legitimately block. Net: owned_net pass yield is still low (~1-2/set, definition_sentence most reliable) — steady weekly accumulation, not bulk. See [[project-smim-hub]].

**§7 lexicon gap fixed same day:** config/content-terms/ko.json superlatives was missing 프리미엄/철저/완벽/엄격 — they reached 'passed'. Added → now route to needs_human (backstop). "프리미엄" is one the owner's own facts file says to avoid.
