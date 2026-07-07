# CLAUDE.md — project instructions (auto-loaded every session, every PC)

This repo is worked on from **multiple PCs**, synced through GitHub. Git carries
the **code + the memory/handoff docs in this repo** — it does NOT carry the
Claude Code chat transcript (that stays local to each machine). So the durable
cross-PC context lives in-repo: **`HANDOFF.md`** (current state + next steps) and
**`.project-memory/`** (the persistent project memory). Read them to continue
work started on another machine.

## 🔄 Multi-PC sync protocol (FOLLOW EVERY SESSION)

**At session START:**
1. `git pull --rebase` (or `git pull`) on `main` to pick up work pushed from the other PC.
2. Read `HANDOFF.md` and `.project-memory/MEMORY.md` (+ any linked memory file) to reload context.

**During the session:** keep changes committed in logical, tested chunks.

**At session END (or when finishing a unit of work):**
1. Update `HANDOFF.md` — current state, what changed, what's next, any new key facts.
2. Mirror memory: copy the working memory into `.project-memory/` so it travels:
   `cp "$HOME/.claude/projects/c--aeo-geo-optimization/memory/"*.md .project-memory/`
   (and keep the `~/.claude/...` copy as the live auto-memory on this PC).
3. `git add -A && git commit && git push origin main` — INCLUDING `HANDOFF.md` and `.project-memory/`.

> Rationale: the auto-memory dir `~/.claude/projects/<pathhash>/memory/` is
> keyed by the local project path, so it does NOT auto-sync across PCs/clones.
> `.project-memory/` in the repo is the portable source of truth; on a fresh PC,
> read it (and optionally copy it back into `~/.claude/.../memory/`).

## Quick-reference facts (verified 2026-07)
- Product: OFF-SITE AEO/GEO service — generate citable off-site content, publish to owned-net GitHub Pages hubs, measure Share-of-Model-Recall (mention⊇citation⊇recommendation).
- **Canonical customers (live DB ids):** EMORA = slug `emora`, id `3cb680d5-190d-4485-b456-4c645a91a16a`, template `ai-companion`; SMIM = slug `smimdate`, id `f9d13b5c-32c7-4e89-ada4-7a7a876882d1`, template `rotation-dating`. (`emora-mini` 5179c0f3 is ORPHANED — do not use.)
- Hubs: EMORA `https://sonjeongwons.github.io/aeo-owned-net-hub/`, SMIM `https://sonjeongwons.github.io/aeo-smim-hub/`.
- Constraints: **§0** OFF-SITE ONLY (never scrape/represent COMPETITOR domains; the customer's OWN domain only under explicit owner direction). **§7** HONESTY (only verifiable/sourced claims; no superlatives/fabrication; claim⊆source binding; 표시광고법 risk on unverifiable numbers).
- Stack: TypeScript Node22 ESM (NodeNext, `.js` specifiers, exactOptionalPropertyTypes), PostgreSQL+TimescaleDB+Kysely, Next.js15 dashboard (`apps/web`), vitest, Gemini free tier. Run tests: `npx vitest run`. Typecheck: `npx tsc --noEmit`.
- Working style: run cross-checking (adversarial) reviews on risky changes; Opus for design, Sonnet for code; commit + test every change; secrets are ROTATE-on-exposure (never echo/commit tokens).

## Secrets / infra
- GitHub Actions crons: `measure.yml` (Mon) + `publish.yml` (Tue) — Timescale Cloud + Gemini free key + Gmail SMTP report. `report_only=true` dispatch sends the email without a measurement cycle.
- Free-tier Gemini key: daily quota exhausts fast → generation may be deferred to quota reset.
