#!/usr/bin/env bash
# scripts/sync-owned-net-github.sh
#
# Track 3 hosting: push the FsTarget owned-net tree (OWNED_NET_OUT_DIR) to the
# GitHub Pages repo so the §7-gated brand answer pages become PUBLICLY crawlable.
#
# The OwnedNetConnector (FsTarget) writes the static tree locally; this script is
# the "hosting" step (the OwnedNetTarget swap-seam realised as GitHub Pages).
# Run after publish-content/publish-owned-net writes new pages.
#
# Usage:  bash scripts/sync-owned-net-github.sh
# Env:    OWNED_NET_OUT_DIR (default ./.owned-net-hub)
#         GH_PAGES_REPO     (default sonjeongwons/aeo-owned-net-hub)
set -euo pipefail
export MSYS_NO_PATHCONV=1

DIR="${OWNED_NET_OUT_DIR:-./.owned-net-hub}"
REPO="${GH_PAGES_REPO:-sonjeongwons/aeo-owned-net-hub}"

cd "$DIR"
[ -d .git ] || { git init -q; git branch -M main; }
git config user.email "doradola38@gmail.com"
git config user.name  "sonjeongwons"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${REPO}.git"

git add -A
if git diff --cached --quiet; then
  echo "[sync] no changes to publish"
  exit 0
fi
git commit -q -m "owned-net hub: sync $(git diff --cached --name-only | wc -l) file(s)"
git push -u origin main 2>&1 | tail -2
echo "[sync] pushed → https://$(echo "$REPO" | cut -d/ -f1).github.io/$(echo "$REPO" | cut -d/ -f2)/"
