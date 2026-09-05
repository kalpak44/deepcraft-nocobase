#!/usr/bin/env bash
#
# Remove the stray filterByTk from the OwnAI Board kanban card.
#
#   ./scripts/fix-kanban-filterbytk.sh
#
# The board page (/admin/nxaie4s6hqw) pins the renderer — "Aw, Snap!" with
# RESULT_CODE_HUNG — on most loads. The cause is one key on the kanban card
# model gug6q17sxpn:
#
#   cardSettings.popup.filterByTk = "{{ctx.record.id}}"
#
# With it, the card's popup flow re-resolves per record and re-dispatches, and
# the flow engine spins in dispatchEvent -> withApplyFlowCache -> runFlow. The
# whole stack sits in @nocobase/plugin-kanban; no server error, every API call
# 200. The pre-import database had the same card WITHOUT that key and rendered
# fine, and every other model in the 29-node page subtree is byte-identical —
# so this one key is the entire difference.
#
# It arrived with the import from nocobase.pavel-usanli.online, which still
# carries it. Re-running that import brings it back.
#
# Verify afterwards with `just smoke` — the board is checked three times because
# the hang is a race, not every load.
set -euo pipefail

cd "$(dirname "$0")/.."

[ -f .env ] || { echo "no .env in $(pwd) — copy .env.example first" >&2; exit 2; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${NOCOBASE_PUBLIC_URL:?set NOCOBASE_PUBLIC_URL in .env}"
: "${NOCOBASE_ROOT_EMAIL:?set NOCOBASE_ROOT_EMAIL in .env}"
: "${NOCOBASE_ROOT_PASSWORD:?set NOCOBASE_ROOT_PASSWORD in .env}"

API="${NOCOBASE_PUBLIC_URL%/}/api"
MODEL_UID=gug6q17sxpn

# The credentials go in via a file rather than the command line so they stay out
# of the process list and the shell history.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077

python3 - "$work/signin.json" <<'PY'
import json, os, sys
json.dump(
    {"account": os.environ["NOCOBASE_ROOT_EMAIL"], "password": os.environ["NOCOBASE_ROOT_PASSWORD"]},
    open(sys.argv[1], "w"),
)
PY

echo "-> signing in to ${NOCOBASE_PUBLIC_URL}"
code=$(curl -sS -X POST "${API}/auth:signIn" \
  -H 'X-Authenticator: basic' -H 'Content-Type: application/json' \
  -d @"$work/signin.json" -o "$work/auth.json" -w '%{http_code}')
[ "$code" = "200" ] || { echo "sign in failed: HTTP $code" >&2; exit 1; }

TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["token"])' "$work/auth.json")
[ -n "$TOKEN" ] || { echo "sign in returned no token" >&2; exit 1; }

echo "-> reading ${MODEL_UID}"
curl -sS "${API}/flowModels:get?filterByTk=${MODEL_UID}" \
  -H "Authorization: Bearer ${TOKEN}" -o "$work/before.json"

if ! grep -q filterByTk "$work/before.json"; then
  echo "   filterByTk is already gone — nothing to do"
  exit 0
fi
echo "   before: $(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["data"]["stepParams"]))' "$work/before.json")"

# flowModels:save, NOT flowModels:update. stepParams is not a column — it lives
# inside the model's `options` JSON blob — so the default update action ignores
# it and still answers 200, leaving the row untouched. save goes through
# upsertModel -> updateSingleNode, which spreads the payload over the existing
# options at the top level, so passing stepParams replaces the whole object and
# the unwanted key is gone rather than merged back in.
#
# The payload is deliberately a leaf: no subModels, so modelToSingleNodes emits
# exactly one node and the card's children are left alone. No parentId either —
# supplying one would rewrite the parent link.
echo "-> removing filterByTk"
printf '%s' '{"uid":"'"${MODEL_UID}"'","stepParams":{"cardSettings":{"popup":{"tryTemplate":false}}}}' > "$work/patch.json"
code=$(curl -sS -X POST "${API}/flowModels:save" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d @"$work/patch.json" -o "$work/update.json" -w '%{http_code}')
[ "$code" = "200" ] || { echo "update failed: HTTP $code" >&2; head -c 400 "$work/update.json" >&2; echo >&2; exit 1; }

# Read back rather than trusting the 200 — that is exactly how the first attempt
# at this looked like it had worked when it had changed nothing at all.
echo "-> verifying"
curl -sS "${API}/flowModels:get?filterByTk=${MODEL_UID}" \
  -H "Authorization: Bearer ${TOKEN}" -o "$work/after.json"
echo "   after:  $(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["data"]["stepParams"]))' "$work/after.json")"

if grep -q filterByTk "$work/after.json"; then
  echo "filterByTk is still present after the update" >&2
  exit 1
fi

echo
echo "done — now run: just smoke"
