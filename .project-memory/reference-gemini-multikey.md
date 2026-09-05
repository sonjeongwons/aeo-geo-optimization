---
name: reference-gemini-multikey
description: "Gemini multi-key rotation capability (GEMINI_API_KEYS) — how it works, the key-format validation lesson, and the model-deprecation bug it surfaced"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-05T16:34:19.812Z
---

Added 2026-09-06 because the owner has multiple Gemini API keys from separate
Google Cloud projects/accounts and wanted to use them to speed up free-tier-limited
generation/measurement work. Free-tier Gemini quota is **per-project, not per-key**
— multiple keys only help when each comes from a genuinely distinct project/account,
not several keys pulled from the same project.

**Implementation:** `GeminiAdapter` (`src/providers/gemini.ts`) takes
`apiKey: string | string[] | undefined`, round-robins across all configured keys
via an internal `_call()` wrapper, and on a rate-limit error tries the NEXT key
immediately (no wait) before falling back to exponential backoff once every key in
a round is rate-limited. Single-key behavior is unchanged. `GEMINI_API_KEYS` env
var (comma-separated) takes priority over the single `GEMINI_API_KEY`;
`geminiApiKeys()` in `src/config/env.ts` resolves the effective list, and every
`makeGeminiAdapter()` call site was updated to use it (registry.ts, genContent,
gateContent, diagnoseUrl, genTemplate, api/routes/generate.ts).

**Key-format validation lesson:** the owner pasted 7 strings to use as keys; only
1 matched the real Gemini API key format (`AIzaSy...`, ~39 chars). The other 6 all
shared an identical `AQ.Ab8RN6...` prefix — NOT a Gemini/Google AI Studio key format,
almost certainly some other credential type pasted by mistake (never identified
which). Flagged this before wiring anything in rather than trusting the raw paste;
owner didn't dispute it and said to proceed with what was confirmed. **Lesson: when
a user pastes multiple credentials to use in bulk, check the format matches the
service's known key shape before wiring any of them in — a shared unusual prefix
across several values is a strong signal they're not what the user thinks they are.**
Currently armed with 2 confirmed-valid keys (the pre-existing one + the 1 new valid
one); the other 6 need to be re-verified/resent from Google AI Studio's "Get API
key" page for full rotation.

**Bug this surfaced:** smoke-testing the new key found Google had deprecated the
pinned model id `gemini-2.5-flash-lite` for NEW Google Cloud projects (404 "no
longer available to new users"). That id was `DEFAULT_JUDGE_MODEL` in
`src/judge/llmJudge.ts` — the model used for EVERY judge call in production that
doesn't pass an explicit `preferredJudgeModelId` (confirmed the real call site,
`runResponse.ts`, never passes one). Fixed by switching to the `gemini-flash-lite-latest`
"-latest" alias everywhere the id is a functional value (llmJudge.ts, pricing.ts,
loadTemplate.ts's DB model seed) instead of a pinned dated id — avoids repeating
this exact failure mode when Google eventually deprecates whatever the current
"latest" resolves to. `gemini-2.5-flash` and `gemini-flash-latest` were confirmed
working on the new key; `gemini-flash-lite-latest` itself was NOT live-tested (ran
out of free-tier quota mid-investigation) — worth checking the next real
measure.yml/publish.yml run for judge errors on that specific id.
