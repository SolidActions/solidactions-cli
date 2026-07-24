#!/usr/bin/env bash
#
# Smoke-test `solidactions oauth-action list|search|view` end to end.
#
# By default this runs the built CLI against a real local stub server
# (scripts/smoke-oauth-actions-server.mjs), so it needs no credentials and is
# safe in CI. Point it at a deployed server instead with:
#
#   SOLIDACTIONS_HOST=https://app.solidactions.com \
#   SOLIDACTIONS_API_KEY=... \
#   SOLIDACTIONS_WORKSPACE_ID=... \
#   bash scripts/smoke.sh --live
#
# Exits non-zero on the first failed check.

set -euo pipefail

cd "$(dirname "$0")/.."

LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

CLI="node dist/index.js"
SERVER_PID=""

PORT_FILE=""

cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "$PORT_FILE" ]] && rm -f "$PORT_FILE" || true
}
trap cleanup EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

check_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$label"; else
    printf '\033[31mExpected output to contain:\033[0m %s\n' "$needle"
    printf '\033[31mActual output:\033[0m\n%s\n' "$haystack"
    fail "$label"
  fi
}

check_absent() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$label"; else
    printf '\033[31mExpected output NOT to contain:\033[0m %s\n' "$needle"
    printf '\033[31mActual output:\033[0m\n%s\n' "$haystack"
    fail "$label"
  fi
}

if [[ ! -f dist/index.js ]]; then
  echo "dist/index.js missing — run 'npm run build' first." >&2
  exit 1
fi

if [[ "$LIVE" -eq 1 ]]; then
  : "${SOLIDACTIONS_HOST:?SOLIDACTIONS_HOST required with --live}"
  : "${SOLIDACTIONS_API_KEY:?SOLIDACTIONS_API_KEY required with --live}"
  : "${SOLIDACTIONS_WORKSPACE_ID:?SOLIDACTIONS_WORKSPACE_ID required with --live}"
  echo "Smoke: live server at $SOLIDACTIONS_HOST"
  CALENDAR_ACTION_ID="conn_mod_def::GJ6RlnIYK20::YzuWSmaVQgurletRDNJavA"
  GMAIL_ACTION_ID="conn_mod_def::GGSNOTZxFUU::ZWXBuJboTpS3Q_U06pF8gA"
else
  # Start the stub server on an ephemeral port and read back the port it bound.
  PORT_FILE=$(mktemp)
  node scripts/smoke-oauth-actions-server.mjs > "$PORT_FILE" &
  SERVER_PID=$!

  PORT_LINE=""
  for _ in $(seq 1 50); do
    PORT_LINE=$(head -n 1 "$PORT_FILE" 2>/dev/null || true)
    [[ "$PORT_LINE" == PORT=* ]] && break
    sleep 0.1
  done
  [[ "$PORT_LINE" == PORT=* ]] || fail "stub server did not report a port"
  PORT="${PORT_LINE#PORT=}"

  export SOLIDACTIONS_HOST="http://127.0.0.1:${PORT}"
  export SOLIDACTIONS_API_KEY="smoke-test-key"
  export SOLIDACTIONS_WORKSPACE_ID="smoke-workspace"
  echo "Smoke: stub server at $SOLIDACTIONS_HOST"
  CALENDAR_ACTION_ID="conn_mod_def::GJ6RlnIYK20::YzuWSmaVQgurletRDNJavA"
  GMAIL_ACTION_ID="conn_mod_def::GGSNOTZxFUU::ZWXBuJboTpS3Q_U06pF8gA"
fi

echo
echo "1. oauth-action list gmail --limit 5"
OUT=$($CLI oauth-action list gmail --limit 5)
check_contains "$OUT" "/gmail/v1/users/me/messages/send" "lists the send-message path"
check_contains "$OUT" "POST" "renders the HTTP method"

echo
echo "2. oauth-action search gmail 'list messages unread' --limit 3"
OUT=$($CLI oauth-action search gmail "list messages unread" --limit 3)
check_contains "$OUT" "action_id:" "search output includes action_id lines"
check_contains "$OUT" "List Messages" "search matches the List Messages action"

echo
echo "3. oauth-action view gmail <modifier action>"
OUT=$($CLI oauth-action view gmail "$GMAIL_ACTION_ID")
check_contains "$OUT" "Paste-ready snippet:" "view renders a paste-ready snippet"
check_contains "$OUT" "connectionKey: ctx.vars" "modifier body wires connectionKey from ctx.vars"
check_absent   "$OUT" "process.env" "default snippet uses ctx.vars, not process.env"

echo
echo "4. oauth-action view google-calendar <array-query action> --json"
OUT=$($CLI oauth-action view google-calendar "$CALENDAR_ACTION_ID" --json)
check_contains "$OUT" "eventTypes" "json output exposes the array query param"
if command -v jq >/dev/null 2>&1; then
  KEYS=$(printf '%s' "$OUT" | jq -r '.io_schema.ioExample.input.query | keys[]' | head -3)
  [[ -n "$KEYS" ]] && pass "jq can enumerate query keys" || fail "jq found no query keys"
else
  pass "jq not installed — skipping key enumeration"
fi

echo
echo "5. oauth-action view google-calendar <array-query action> (human)"
OUT=$($CLI oauth-action view google-calendar "$CALENDAR_ACTION_ID")
check_contains "$OUT" 'eventTypes=${encodeURIComponent("default")}&eventTypes=' "array query params repeat the key"
check_absent   "$OUT" "encodeURIComponent([" "array is not stringified into one value"

echo
echo "6. oauth-action view gmail no-such-action (404 path)"
set +e
OUT=$($CLI oauth-action view gmail no-such-action 2>&1)
CODE=$?
set -e
check_contains "$OUT" "Action not found" "404 renders the friendly not-found message"
[[ "$CODE" -ne 0 ]] && pass "404 path exits non-zero" || fail "expected non-zero exit on 404"

echo
printf '\033[32mSmoke passed.\033[0m\n'
