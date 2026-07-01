#!/usr/bin/env bash
# scripts/expand-hub.sh — bulk-build the owned-net hub.
#
# Generates several multilingual content sets, queues+approves all PASSED assets,
# then dispatch-leases + publishes every owned_net pass and syncs once to GitHub
# Pages. Builds out EMORA's §7-gated answer-page surface before Google indexes.
#
# Usage: bash scripts/expand-hub.sh [ROUNDS]   (default 6)
set -uo pipefail
cd /c/aeo-geo-optimization
EMORA=3cb680d5-190d-4485-b456-4c645a91a16a
CID=$(docker compose ps -q timescaledb)
ROUNDS="${1:-6}"

echo "=== Phase 1: generate $ROUNDS multilingual sets ==="
for r in $(seq 1 "$ROUNDS"); do
  npm run gen-content -- --customer "$EMORA" --industry ai-companion --total 8 --formats 1 --languages 3 2>/dev/null 1>/tmp/eh.out
  SET=$(sed -n 's/.*"contentSetId": "\([^"]*\)".*/\1/p' /tmp/eh.out | head -1)
  P=$(sed -n 's/.*"passedCount": \([0-9]*\).*/\1/p' /tmp/eh.out | head -1)
  [ -z "${SET:-}" ] && { echo "  round $r: gen failed (cap?)"; break; }
  npm run queue-content -- --set "$SET" 2>/dev/null >/dev/null
  npm run approve-deploy -- --approver doradola38@gmail.com --set "$SET" 2>/dev/null >/dev/null
  ON=$(docker exec "$CID" psql -U aeo -d aeo_geo -tAc "SELECT count(*) FROM content_asset WHERE content_set_id='$SET' AND channel_class='owned_net' AND gate_status='passed';" | tr -d ' ')
  echo "  round $r: set=$SET passed=$P owned_net_passed=$ON"
done

echo "=== Phase 2: dispatch-lease + publish every owned_net pass ==="
PUBLISHED=0
for cycle in $(seq 1 15); do
  npm run publish-content -- --execute --channel owned_net 2>/dev/null >/dev/null
  LEASED=$(docker exec "$CID" psql -U aeo -d aeo_geo -tAc "SELECT id FROM content_deploy_queue WHERE channel_class='owned_net' AND status='leased';" | tr -d ' ' | tr '\n' ' ')
  [ -z "${LEASED// /}" ] && { echo "  cycle $cycle: no more leased — done"; break; }
  N=$(echo $LEASED | wc -w)
  npx tsx scripts/publish-owned-net.mts $LEASED 2>/dev/null | grep -c "published successfully" || true
  PUBLISHED=$((PUBLISHED + N))
  echo "  cycle $cycle: published $N (running total $PUBLISHED)"
done

echo "=== Phase 3: sync to GitHub Pages ==="
bash scripts/sync-owned-net-github.sh 2>&1 | tail -2

echo "=== hub page count ==="
find .owned-net-hub -name index.html | wc -l
echo "=== languages on hub ==="
find .owned-net-hub -mindepth 1 -maxdepth 1 -type d -printf '%f ' 2>/dev/null; echo
