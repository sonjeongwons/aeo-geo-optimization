#!/usr/bin/env bash
# scripts/auto-publish.sh
#
# UNATTENDED full AEO/GEO publish cycle for ONE customer:
#   gen-content → §7 gate → queue(passed) → auto-approve → lease → publish →
#   rebuild hub index/llms.txt → git push to the customer's GitHub Pages hub.
#
# SAFETY (this is the "no manual approval" path — the automated §7 gates ARE the
# review):
#   • ONLY gate_status='passed' assets are ever queued/published. blocked and
#     needs_human are structurally excluded (queue-content filters them).
#   • The automated sign-off is recorded in content_deploy_queue.approved_by and
#     copied to url_registry.approver_audit at publish time (§12 audit trail).
#   • Every published page is reversible (OwnedNetConnector.unpublish).
#   • Only the owned_net connector is 'ready'; other channels are stubs and skip.
#
# Required env:
#   CUSTOMER_ID, INDUSTRY, HUB_REPO (owner/repo), OWNED_NET_HUB_BASE_URL,
#   OWNED_NET_OUT_DIR, HUB_BRAND, DATABASE_URL, GEMINI_API_KEY
# Optional env:
#   APPROVER (default "auto-publish@aeo (owner-authorized)"), FORMATS (5),
#   TOTAL (16), GH_TOKEN (for CI push — see sync-owned-net-github.sh)
#
# Exit 0 even when a cycle produces nothing publishable (transient Gemini load,
# throttle, or all-blocked) so a scheduler treats "no new pages" as success.
set -uo pipefail
export MSYS_NO_PATHCONV=1

: "${CUSTOMER_ID:?need CUSTOMER_ID}"
: "${INDUSTRY:?need INDUSTRY}"
: "${HUB_REPO:?need HUB_REPO}"
: "${OWNED_NET_HUB_BASE_URL:?need OWNED_NET_HUB_BASE_URL}"
: "${OWNED_NET_OUT_DIR:?need OWNED_NET_OUT_DIR}"
: "${HUB_BRAND:?need HUB_BRAND}"
export OWNED_NET_HUB_BASE_URL OWNED_NET_OUT_DIR HUB_BRAND
export GH_PAGES_REPO="$HUB_REPO"
APPROVER="${APPROVER:-auto-publish@aeo (owner-authorized)}"
FORMATS="${FORMATS:-5}"
TOTAL="${TOTAL:-16}"

echo "[auto-publish] customer=$CUSTOMER_ID industry=$INDUSTRY brand=$HUB_BRAND hub=$HUB_REPO"

# 1) Generate + gate over several attempts (owned_net is the sole publishable
#    channel; per-cycle pass yield is low, so accumulate across ATTEMPTS sets).
#    Each producing set is queued (passed-only) + auto-approved immediately.
ATTEMPTS="${ATTEMPTS:-3}"
ANY_APPROVED=0
for i in $(seq 1 "$ATTEMPTS"); do
  GENOUT=$(npx tsx src/cli/genContent.ts --customer "$CUSTOMER_ID" --industry "$INDUSTRY" \
    --channel owned_net --formats "$FORMATS" --total "$TOTAL" 2>&1)
  SET=$(echo "$GENOUT" | grep -aoE "contentSetId=[a-f0-9-]+" | head -1 | cut -d= -f2)
  STATS=$(echo "$GENOUT" | grep -aoE 'passed=[0-9]+ blocked=[0-9]+ needs_human=[0-9]+' | head -1)
  echo "[auto-publish] attempt $i/$ATTEMPTS set=${SET:-none} $STATS"
  [ -z "$SET" ] && continue
  # queue-content queues ONLY passed assets; skip approve if 0 queued.
  QN=$(npx tsx src/cli/queueContent.ts --set "$SET" 2>&1 | grep -aoE "queued=[0-9]+" | grep -oE "[0-9]+" | head -1)
  if [ "${QN:-0}" -gt 0 ]; then
    npx tsx src/cli/approveDeploy.ts --approver "$APPROVER" --set "$SET" >/dev/null 2>&1 || true
    ANY_APPROVED=1
  fi
done
if [ "$ANY_APPROVED" = 0 ]; then echo "[auto-publish] 0 passed assets across $ATTEMPTS attempts — no new pages"; exit 0; fi

# 4) Lease approved owned_net rows (throttle-bounded).
npx tsx src/cli/publishContent.ts --execute --channel owned_net >/dev/null 2>&1 || true

# 5) Publish the leased owned_net rows for THIS customer.
IDS=$(npx tsx scripts/leased-queue-ids.mts "$CUSTOMER_ID" 2>/dev/null | tail -1)
if [ -z "${IDS// /}" ]; then echo "[auto-publish] nothing leased (throttle or 0 passed) — no new pages"; exit 0; fi
echo "[auto-publish] publishing leased rows: $IDS"
npx tsx scripts/publish-owned-net.mts $IDS 2>&1 | grep -aoE "published url=[^ ]+" || true

# 6) Refresh the hub-graph internal links across ALL pages (new + existing), then
#    rebuild the index + llms.txt (brand-scoped) and push to GitHub Pages.
npx tsx scripts/rerender-hub.mts 2>&1 | grep -aoE "re-rendered.*" || true
npx tsx scripts/gen-hub-index.mts 2>&1 | grep -aoE "wrote linking.*" || true
npx tsx scripts/gen-hub-extras.mts 2>&1 | grep -aoE "wrote [0-9]+ index.*" || true
bash scripts/sync-owned-net-github.sh 2>&1 | tail -2

echo "[auto-publish] done customer=$CUSTOMER_ID"
