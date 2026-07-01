/** Simulate how many emora-plan work-units the subsample policy would ground. */
import { shouldGround } from "../src/providers/groundingPolicy.js";

function count(pct: number): string {
  let on = 0, tot = 0;
  for (let q = 0; q < 36; q++) {
    for (let s = 0; s < 5; s++) {
      tot++;
      if (shouldGround(`question-${q}:en:${s}`, { GEMINI_GROUNDING_SAMPLE_PCT: String(pct) })) on++;
    }
  }
  return `${on}/${tot}`;
}

for (const p of [0, 3, 5, 10, 25, 100]) {
  console.log(`PCT=${p} -> grounded ${count(p)}`);
}
