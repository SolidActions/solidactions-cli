#!/usr/bin/env bash
# Prints export lines for the live crews suite against the local sa-dev stack.
# Usage: eval "$(scripts/live-test-env.sh)"
set -euo pipefail
APP=/home/mercer/projects/solid/solidactions-app
port=$(grep -E '^APP_PORT=' "$APP/.env" | cut -d= -f2)
out=$(cd "$APP" && ./scripts/local-dev artisan tinker --execute '
$u = \App\Models\User::where("email","test@example.com")->firstOrFail();
$ws = $u->workspaces()->firstOrFail();
echo "LIVE|".$u->createToken("cli-live-".time())->plainTextToken."|".$ws->id.PHP_EOL;' | grep '^LIVE|')
token=$(cut -d'|' -f2- <<<"$out" | rev | cut -d'|' -f2- | rev)
ws=$(rev <<<"$out" | cut -d'|' -f1 | rev)
echo "export SOLIDACTIONS_LIVE_HOST=http://localhost:$port"
echo "export SOLIDACTIONS_LIVE_API_KEY='$token'"
echo "export SOLIDACTIONS_LIVE_WORKSPACE_ID=$ws"
