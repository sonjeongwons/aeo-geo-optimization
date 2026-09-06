---
name: project-github-actions-billing
description: aeo-geo-optimization repo made PUBLIC on 2026-09-06 to fix a GitHub Actions billing block
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-06T21:39:16.043Z
---

On 2026-09-06, `gh workflow run publish.yml` started failing INSTANTLY (in ~4s, before
any job step ran) with: "The job was not started because recent account payments have
failed or your spending limit needs to be increased." Root cause: `aeo-geo-optimization`
was a PRIVATE repo, so its GitHub Actions minutes count against the account's monthly
free allowance (2,000 min/month on GitHub Free) — a day of manual dispatches with
`attempts=5` across 3 customers (each run took 1-3 hours) almost certainly exhausted it.

Could not get exact usage numbers via `gh api` — the billing endpoint needs a `user`
OAuth scope the CLI token didn't have, and getting it requires an interactive browser
consent flow Claude can't do. Gave the owner the options (check
github.com/settings/billing, wait for the monthly reset, or make the repo public) —
**owner chose to make the repo public** ("저장소를 public으로 전환해주세요").

Before flipping visibility, Claude scanned the full git history (`git log --all -p`)
and current tree for leaked plaintext secrets (AIzaSy... Gemini keys, ghp_/gho_ GitHub
tokens, postgres:// connection strings with embedded passwords) — found NONE. `.env`
was never committed (matches the project's designed encrypted-env-sync pattern, see
[[feedback-multipc-git-sync]] / CLAUDE.md's `secrets/env.enc` approach). Safe to make
public.

**Repo is now public** (`gh repo edit ... --visibility public
--accept-visibility-change-consequences`, confirmed via `gh repo view`). Public repos
get UNLIMITED free GitHub Actions minutes, so this should permanently resolve the
billing block. Verified: a dispatch immediately after the flip started running
normally (not an instant billing failure).

How to apply: if `gh workflow run` ever fails instantly again with a billing-type
error on this repo, something else is wrong (public repos shouldn't hit Actions
minutes limits) — check the account's overall payment status, not just this repo's
Actions usage. Also: this repo's code, full history, and commit messages are now
world-readable — keep that in mind before referencing anything sensitive in future
commit messages or code comments (secrets themselves were already safe via the
encrypted-env pattern, but avoid putting business-sensitive specifics like real
customer names' internal details in commit messages if that ever becomes a concern —
in practice the owner's customers (unsanpartners/sharejoa/emora) are already named
throughout the repo by design, so this is a pre-existing posture, not a new risk
introduced by the visibility flip).
