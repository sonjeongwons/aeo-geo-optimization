/**
 * src/content/gates/adversarialBlocklist.ts
 *
 * Research-driven §7 gate (DESIGN-research-aeo-geo.md rank 12).
 *
 * Fail-closed structural blocklist for adversarial AEO/GEO manipulations that
 * "work" technically but violate §7 honesty AND risk total exclusion by an
 * answer engine's binary rerank gate (honesty == performance here):
 *   - Hidden / invisible text (display:none, white-on-white, font-size:0,
 *     opacity:0, aria-hidden stuffing, off-screen positioning, zero-width chars).
 *   - Prompt-injection payloads ("ignore previous instructions", "as an AI
 *     language model", system/inst markers) aimed at the engine reading the page.
 *   - Markup injection (<script>/<style>/<iframe>) that has no place in a prose
 *     answer body.
 *
 * Evidence: hidden-text boosts mentions ~2.5x (2406.18382) but is cloaking;
 * RAG corpus poisoning / StealthRank (2412.20953) abuse injected instructions;
 * Perplexity's binary rerank gate excludes borderline-spam entirely.
 *
 * BLOCK (not needs_human): these are never acceptable, so a generated page can
 * NEVER ship one. PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";

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

const BLOCKLIST_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // ---- Prompt injection aimed at the reading engine ----
  { name: "injection-ignore", pattern: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|context)\b/i },
  { name: "injection-disregard", pattern: /\bdisregard\s+(?:the\s+)?(?:above|previous|prior|system|all)\b/i },
  { name: "injection-as-ai", pattern: /\bas\s+an?\s+ai\s+(?:language\s+)?model\b/i },
  { name: "injection-you-are", pattern: /\byou\s+are\s+(?:now\s+)?(?:chatgpt|gpt-?\d|claude|gemini|a\s+helpful\s+assistant|an\s+ai)\b/i },
  { name: "injection-system-prompt", pattern: /\b(?:system\s+prompt|new\s+instructions?\s*:|override\s+(?:your\s+)?instructions?)\b/i },
  { name: "injection-chat-markers", pattern: /\[INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>/i },
  { name: "injection-recommend-command", pattern: /\b(?:always|you\s+must|be\s+sure\s+to)\s+recommend\b/i },

  // ---- Korean prompt injection (W1.9) — no \b word boundaries in CJK ----
  { name: "ko-injection-ignore", pattern: /(?:이전|위의?|앞의?|모든|이전의)\s*(?:지시(?:사항)?|명령|프롬프트|지침)(?:을|를)?\s*(?:무시|잊)/ },
  { name: "ko-injection-system", pattern: /시스템\s*프롬프트|새(?:로운)?\s*지시(?:사항)?\s*[:：]/ },
  { name: "ko-injection-you-are", pattern: /당신은\s*(?:이제|지금)?\s*(?:챗지피티|GPT|클로드|제미나이|AI|어시스턴트|도우미)/ },
  { name: "ko-injection-recommend", pattern: /(?:반드시|무조건|꼭|항상)\s*(?:추천|권장)(?:해|하)/ },

  // ---- Japanese prompt injection (W1.9) ----
  { name: "ja-injection-ignore", pattern: /(?:前|上|以前|これまで|すべて)の?\s*(?:指示|命令|プロンプト|指定)(?:を|は)?\s*(?:無視|忘れ)/ },
  { name: "ja-injection-system", pattern: /システム\s*プロンプト|新しい指示\s*[:：]/ },
  { name: "ja-injection-you-are", pattern: /あなたは\s*(?:今|これから)?\s*(?:ChatGPT|GPT|Claude|Gemini|AI|アシスタント)/ },
  { name: "ja-injection-recommend", pattern: /(?:必ず|絶対に|常に)\s*(?:推薦|おすすめ|推奨)/ },

  // ---- Hidden / cloaked text (if any markup leaks into the body) ----
  { name: "hidden-display-none", pattern: /display\s*:\s*none/i },
  { name: "hidden-visibility", pattern: /visibility\s*:\s*hidden/i },
  { name: "hidden-font-size-0", pattern: /font-size\s*:\s*0(?:px|pt|em)?\b/i },
  { name: "hidden-opacity-0", pattern: /opacity\s*:\s*0(?:\.0+)?\b/i },
  { name: "hidden-white-on-white", pattern: /color\s*:\s*(?:#f{3,6}\b|white|rgb\(\s*255\s*,\s*255\s*,\s*255)/i },
  { name: "hidden-aria", pattern: /aria-hidden\s*=\s*["']?true/i },
  { name: "hidden-offscreen", pattern: /(?:left|top|text-indent)\s*:\s*-\s*\d{3,}/i },

  // ---- Markup / script injection (no place in a prose answer) ----
  { name: "markup-script", pattern: /<\s*script\b/i },
  { name: "markup-style", pattern: /<\s*style\b/i },
  { name: "markup-iframe", pattern: /<\s*iframe\b/i },
];

// Invisible / bidi control characters used to hide or reorder text:
// U+200B-200F (zero-width space, ZWNJ, ZWJ, LRM, RLM), U+202A-202E (bidi
// embeddings & overrides), U+2060 (word joiner), U+FEFF (BOM / ZWNBSP).
// Built from \u escapes in a string so no literal invisible chars live in source.
const INVISIBLE_CHARS = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]");

export const adversarialBlocklistGate = {
  name: "adversarialBlocklistGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset } = ctx;
    const bodyText = extractBodyTextForScan(asset);
    if (bodyText.length === 0) {
      return { action: "pass", gate: "adversarialBlocklistGate" };
    }

    const violations: string[] = [];

    if (INVISIBLE_CHARS.test(bodyText)) {
      violations.push("invisible/bidi control characters detected (hidden-text / reorder vector)");
    }
    for (const { name, pattern } of BLOCKLIST_PATTERNS) {
      const m = bodyText.match(pattern);
      if (m) violations.push(`adversarial pattern "${name}" matched: "${m[0]!.slice(0, 60)}"`);
    }

    if (violations.length > 0) {
      return {
        action: "block",
        gate: "adversarialBlocklistGate",
        reason: violations.join("; "),
      };
    }
    return { action: "pass", gate: "adversarialBlocklistGate" };
  },
};
