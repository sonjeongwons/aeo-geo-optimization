#!/usr/bin/env bash
# scripts/expand-comparison.sh — bulk-build comparison ("alternatives to X") pages.
#
# Runs N rounds of FULL-format gen-content (incl. comparison_table, which now
# builds cells from the ingested verified competitor facts), queues+approves all
# PASSED assets, dispatch-leases + publishes every owned_net pass, syncs once.
#
# Usage: bash scripts/expand-comparison.sh [ROUNDS]   (default 4)
set -uo pipefail
cd /c/aeo-geo-optimization
EMORA=3cb680d5-190d-4485-b456-4c645a91a16a
CID=$(docker compose ps -q timescaledb)
ROUNDS="${1:-4}"

echo "=== Phase 1: $ROUNDS full-format rounds (incl. comparison_table) ==="
for r in $(seq 1 "$ROUNDS"); do
  npm run gen-content -- --customer "$EMORA" --industry ai-companion --total 44 2>/dev/null 1>/tmp/ec.out
  SET=$(sed -n 's/.*"contentSetId": "\([^"]*\)".*/\1/p' /tmp/ec.out | head -1)
  P=$(sed -n 's/.*"passedCount": \([0-9]*\).*/\1/p' /tmp/ec.out | head -1)
  [ -z "${SET:-}" ] && { echo "  round $r: gen failed (cap?)"; break; }
  npm run queue-content -- --set "$SET" 2>/dev/null >/dev/null
  npm run approve-deploy -- --approver doradola38@gmail.com --set "$SET" 2>/dev/null >/dev/null
  CMP=$(docker exec "$CID" psql -U aeo -d aeo_geo -tAc "SELECT count(*) FROM content_asset WHERE content_set_id='$SET' AND content_type='comparison' AND channel_class='owned_net' AND gate_status='passed';" | tr -d ' ')
  ON=$(docker exec "$CID" psql -U aeo -d aeo_geo -tAc "SELECT count(*) FROM content_asset WHERE content_set_id='$SET' AND channel_class='owned_net' AND gate_status='passed';" | tr -d ' ')
  echo "  round $r: set=$SET passed=$P owned_net_passed=$ON comparison_owned_net_passed=$CMP"
done

echo "=== Phase 2: dispatch-lease + publish every owned_net pass ==="
for cycle in $(seq 1 20); do
  npm run publish-content -- --execute --channel owned_net 2>/dev/null >/dev/null
  LEASED=$(docker exec "$CID" psql -U aeo -d aeo_geo -tAc "SELECT id FROM content_deploy_queue WHERE channel_class='owned_net' AND status='leased';" | tr -d ' ' | tr '\n' ' ')
  [ -z "${LEASED// /}" ] && { echo "  cycle $cycle: no more leased — done"; break; }
  N=$(echo $LEASED | wc -w)
  npx tsx scripts/publish-owned-net.mts $LEASED 2>/dev/null | grep -c "published successfully" || true
  echo "  cycle $cycle: published $N"
done

echo "=== Phase 3: regenerate hub extras + index, then sync ==="
npx tsx scripts/gen-hub-extras.mts 2>/dev/null | tail -1
npx tsx scripts/gen-hub-index.mts 2>/dev/null | tail -1
bash scripts/sync-owned-net-github.sh 2>&1 | tail -2
echo "=== DONE ==="
