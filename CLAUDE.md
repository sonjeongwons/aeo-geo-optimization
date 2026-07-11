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
- **Canonical customers — LIVE Timescale ids (verified 2026-07-11 against prod DB):** EMORA = slug `emora`, id `b1d999e5-c8c1-4f6a-90a3-4d7dc2773ad5`, industry `ai-character-chat`; SMIM = slug `smimdate`, id `37a8f2bd-97e9-4428-b98a-d892c079e98a`, industry `rotation-dating`. Resolve customers by SLUG, not a hardcoded id. **ORPHANS — never use:** `emora-mini` `5eb8d7ef` (its content+facts were MERGED into `emora` b1d999e5 on 2026-07-11), dangling `f9d13b5c` (smim-style content_assets with NO customer row), `demo` `97c47ce2`. ⚠ The LOCAL dev Postgres has DIFFERENT ids than prod — do NOT copy ids between them; when in doubt run a slug lookup on the target DB.
- Hubs: EMORA `https://sonjeongwons.github.io/aeo-owned-net-hub/`, SMIM `https://sonjeongwons.github.io/aeo-smim-hub/`.
- Constraints: **§0** OFF-SITE ONLY (never scrape/represent COMPETITOR domains; the customer's OWN domain only under explicit owner direction). **§7** HONESTY (only verifiable/sourced claims; no superlatives/fabrication; claim⊆source binding; 표시광고법 risk on unverifiable numbers).
- Stack: TypeScript Node22 ESM (NodeNext, `.js` specifiers, exactOptionalPropertyTypes), PostgreSQL+TimescaleDB+Kysely, Next.js15 dashboard (`apps/web`), vitest, Gemini free tier. Run tests: `npx vitest run`. Typecheck: `npx tsc --noEmit`.
- Working style: run cross-checking (adversarial) reviews on risky changes; Opus for design, Sonnet for code; commit + test every change; secrets are ROTATE-on-exposure (never echo/commit tokens).

## Secrets / infra
- GitHub Actions crons: `measure.yml` (Mon) + `publish.yml` (Tue) — Timescale Cloud + Gemini free key + Gmail SMTP report. `report_only=true` dispatch sends the email without a measurement cycle.
- Free-tier Gemini key: daily quota exhausts fast → generation may be deferred to quota reset.

### Encrypted env sync across PCs (private repo)
Local dev secrets (`.env` = DATABASE_URL, GEMINI_API_KEY, OWNED_NET_* …) travel via git
ENCRYPTED, never plaintext (plaintext in history is permanent + GitHub secret-scanning
auto-revokes tokens). `secrets/env.enc` (committed) is the ciphertext; the passphrase is
the ONE out-of-band secret, stored per-PC in `.env.passphrase` (gitignored) or
`ENV_ENC_PASSPHRASE`.
- After editing `.env`:  `bash scripts/sync-env.sh encrypt`  → then commit `secrets/env.enc`.
- On another PC after clone/pull: put the passphrase in `.env.passphrase`, then
  `bash scripts/sync-env.sh decrypt`  → recreates `.env`. (Also run `gh auth login` there
  for GitHub push; the GitHub PAT is NOT in `.env`.)
- NEVER commit `.env` or `.env.passphrase` (both gitignored). If a real secret ever lands
  in git history, ROTATE it.
