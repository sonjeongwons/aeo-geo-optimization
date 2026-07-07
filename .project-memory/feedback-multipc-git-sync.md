---
name: feedback-multipc-git-sync
description: "Multi-PC workflow — git is the single source of truth; pull before, commit+push (incl. memory + HANDOFF) after"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
---

The owner works this project from MULTIPLE PCs synced via GitHub and wants a single, always-current source of truth across them.

**Why:** git carries code + in-repo docs, but NOT the Claude Code chat transcript (local, path-hash-keyed). So durable cross-PC context must live IN the repo.

**How to apply (every session, enforced by repo `CLAUDE.md`):**
- START: `git pull` on main; read repo `HANDOFF.md` + `.project-memory/MEMORY.md` to reload context.
- END (or each finished unit): update `HANDOFF.md`; mirror `~/.claude/projects/c--aeo-geo-optimization/memory/*.md` → repo `.project-memory/`; `git add -A && commit && push origin main` including HANDOFF + .project-memory.
- The literal chat scrollback does NOT transfer across PCs — HANDOFF.md is the bridge; keep it faithfully current.

See repo `CLAUDE.md` (sync protocol + quick-ref facts) and `HANDOFF.md` (live state). Related: [[project-aeo-geo-quality-overhaul]].
