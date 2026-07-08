#!/usr/bin/env bash
# scripts/sync-env.sh — encrypted-env sync for multi-PC dev (private repo).
#
# Secrets live ENCRYPTED at secrets/env.enc (safe to commit + sync via git). The
# passphrase is the ONE thing shared out-of-band, stored locally in
# .env.passphrase (gitignored, matches .env.* ignore) or ENV_ENC_PASSPHRASE.
#
# On this PC after editing .env:   bash scripts/sync-env.sh encrypt   (then commit secrets/env.enc)
# On another PC after git pull:    bash scripts/sync-env.sh decrypt   (recreates .env)
set -euo pipefail
cmd="${1:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
enc="$here/secrets/env.enc"
plain="$here/.env"
pf_file="$here/.env.passphrase"

pass="${ENV_ENC_PASSPHRASE:-}"
if [ -z "$pass" ] && [ -f "$pf_file" ]; then pass="$(cat "$pf_file")"; fi
if [ -z "$pass" ]; then
  echo "No passphrase. Set ENV_ENC_PASSPHRASE, or put it in .env.passphrase (gitignored)." >&2
  exit 1
fi

case "$cmd" in
  encrypt)
    [ -f "$plain" ] || { echo ".env not found" >&2; exit 1; }
    mkdir -p "$here/secrets"
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$plain" -out "$enc" -pass "pass:$pass"
    echo "encrypted .env -> secrets/env.enc (commit this file)";;
  decrypt)
    [ -f "$enc" ] || { echo "secrets/env.enc not found — git pull first" >&2; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$enc" -out "$plain" -pass "pass:$pass"
    echo "decrypted secrets/env.enc -> .env";;
  *)
    echo "usage: bash scripts/sync-env.sh encrypt|decrypt" >&2; exit 1;;
esac
