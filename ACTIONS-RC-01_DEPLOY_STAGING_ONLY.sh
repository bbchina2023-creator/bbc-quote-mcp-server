#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

TARGET_WORKER="bbc-quote-mcp-server-staging"
BASE_URL="https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev"
CONTROL_DEAL="BBC-15af9054-0cfd-414e-b0c9-90a50ac6d2a6"
EXPECTED_ACTION_BRIDGE="ACTIONS-RC-01"
EXPECTED_MCP_RELEASE="RC-CORR-06C"
EXPECTED_CONTOUR="1.0.5-rc-corr-03"
KEY_FILE="$ROOT_DIR/.gpt_action_key.staging"
CONFIG="wrangler.contour.jsonc"

EXPECTED_CONTOUR_SHA="9a89ada3889ccf327c5dc0d9ac69e4603c55f31f19b8168911d843f09316151d"
EXPECTED_BRIDGE_SHA="9b0fb2828932230e9308ceb5e6476726b0863fdee9b60085b0abe8f53007082f"
EXPECTED_OPENAPI_SHA="85702f1dbada34d440e25d19c0e8072ebc8406f5059aeb591a1fd374cf333c3b"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

json_check() {
  node - "$@"
}

need node
need npm
need npx
need curl
need openssl
need shasum
need awk
need grep

printf '%s\n' "=== ACTIONS-RC-01 STAGING-ONLY DEPLOY ==="
printf '%s\n' "[1/10] Target and source guards"

grep -q '"name"[[:space:]]*:[[:space:]]*"bbc-quote-mcp-server-staging"' "$CONFIG" || die "Wrong Worker target"
grep -q '"main"[[:space:]]*:[[:space:]]*"src/staging-contour-rc.js"' "$CONFIG" || die "Wrong Worker entrypoint"
if grep -q '"name"[[:space:]]*:[[:space:]]*"bbc-quote-mcp-server"[[:space:]]*[,}]' "$CONFIG"; then
  die "Production Worker target detected"
fi

actual_contour_sha="$(shasum -a 256 src/staging-contour-rc.js | awk '{print $1}')"
actual_bridge_sha="$(shasum -a 256 src/action-bridge.js | awk '{print $1}')"
actual_openapi_sha="$(shasum -a 256 openapi-actions.yaml | awk '{print $1}')"
[ "$actual_contour_sha" = "$EXPECTED_CONTOUR_SHA" ] || die "staging-contour-rc.js SHA mismatch"
[ "$actual_bridge_sha" = "$EXPECTED_BRIDGE_SHA" ] || die "action-bridge.js SHA mismatch"
[ "$actual_openapi_sha" = "$EXPECTED_OPENAPI_SHA" ] || die "openapi-actions.yaml SHA mismatch"
echo "SOURCE_GUARD=PASS"

printf '%s\n' "[2/10] Install exact dependencies"
npm ci --no-audit --no-fund

printf '%s\n' "[3/10] Syntax and regression suite"
node --check src/action-bridge.js
node --check src/staging-contour-rc.js
npm test

echo "REGRESSION_SUITE=PASS"

printf '%s\n' "[4/10] Wrangler staging dry-run"
npx wrangler deploy --dry-run -c "$CONFIG" >/tmp/bbc-actions-rc01-dry-run.log 2>&1 || {
  cat /tmp/bbc-actions-rc01-dry-run.log
  die "Wrangler dry-run failed"
}
echo "WRANGLER_DRY_RUN=PASS"

printf '%s\n' "[5/10] Prepare separate GPT Action API key"
if [ ! -f "$KEY_FILE" ]; then
  umask 077
  openssl rand -hex 32 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi
GPT_ACTION_KEY="$(tr -d '\r\n' < "$KEY_FILE")"
[ "${#GPT_ACTION_KEY}" -ge 40 ] || die "Generated GPT Action key is unexpectedly short"
printf '%s' "$GPT_ACTION_KEY" | npx wrangler secret put GPT_ACTION_KEY -c "$CONFIG" >/tmp/bbc-actions-rc01-secret.log 2>&1 || {
  cat /tmp/bbc-actions-rc01-secret.log
  die "Failed to set GPT_ACTION_KEY on staging"
}
echo "GPT_ACTION_KEY=CONFIGURED_STAGING_ONLY"
echo "GPT_ACTION_KEY_FILE=$KEY_FILE"

printf '%s\n' "[6/10] Deploy additive Actions bridge to staging"
npx wrangler deploy -c "$CONFIG" 2>&1 | tee /tmp/bbc-actions-rc01-deploy.log

printf '%s\n' "[7/10] Poll live health identity"
health_pass=0
for i in $(seq 1 24); do
  curl -fsS -H 'cache-control: no-cache' "$BASE_URL/health?actions_rc01=$i-$(date +%s)" -o /tmp/bbc-actions-health.json || true
  if node <<'NODE'
const fs = require('fs');
let h;
try { h = JSON.parse(fs.readFileSync('/tmp/bbc-actions-health.json','utf8')); } catch { process.exit(1); }
const expectedActions = ['generateQuote','getDealStatus','getVerifiedSnapshot','recalculateDeal','validateCanonicalDeal'].sort();
const actualActions = Array.isArray(h.actionContract) ? [...h.actionContract].sort() : [];
const expectedTools = [...expectedActions];
const actualTools = Array.isArray(h.toolContract) ? [...h.toolContract].sort() : [];
const ok = h.ok === true &&
  h.releaseId === 'RC-CORR-06C' &&
  h.contourVersion === '1.0.5-rc-corr-03' &&
  h.actionBridgeVersion === 'ACTIONS-RC-01' &&
  h.actionAuthMode === 'BEARER_API_KEY' &&
  h.actionConfigured === true &&
  h.actionBodyMaxBytes === 90000 &&
  h.actionResponseMaxBytes === 90000 &&
  JSON.stringify(actualActions) === JSON.stringify(expectedActions) &&
  JSON.stringify(actualTools) === JSON.stringify(expectedTools);
if (!ok) {
  console.log(JSON.stringify(h));
  process.exit(1);
}
console.log('HEALTH_ACTION_BRIDGE=PASS');
console.log('WORKER_VERSION=' + String(h.workerVersion?.id || 'unknown'));
NODE
  then
    health_pass=1
    break
  fi
  sleep 5
done
[ "$health_pass" = "1" ] || die "Live health did not converge to ACTIONS-RC-01"

printf '%s\n' "[8/10] Security gate: unauthenticated Action must be rejected before backend"
unauth_code="$(curl -sS -o /tmp/bbc-actions-unauth.json -w '%{http_code}' \
  -X POST "$BASE_URL/actions/get-deal-status" \
  -H 'content-type: application/json' \
  --data "{\"dealId\":\"$CONTROL_DEAL\"}")"
echo "UNAUTH_HTTP=$unauth_code"
[ "$unauth_code" = "401" ] || die "Unauthenticated Action was not rejected with HTTP 401"
grep -q '"UNAUTHORIZED"' /tmp/bbc-actions-unauth.json || die "Unauthorized response contract mismatch"
echo "UNAUTHENTICATED_ACTION_GATE=PASS"

printf '%s\n' "[9/10] Authorized read gates"
status_code="$(curl -sS -o /tmp/bbc-actions-status.json -w '%{http_code}' \
  -X POST "$BASE_URL/actions/get-deal-status" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GPT_ACTION_KEY" \
  --data "{\"dealId\":\"$CONTROL_DEAL\"}")"
echo "STATUS_HTTP=$status_code"
[ "$status_code" = "200" ] || die "Authorized getDealStatus failed"

SNAPSHOT_ID="$(node <<'NODE'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('/tmp/bbc-actions-status.json','utf8'));
if (p.ok !== true || p.action !== 'getDealStatus' || p.actionBridgeVersion !== 'ACTIONS-RC-01') process.exit(2);
if (p.result?.contourVersion !== '1.0.5-rc-corr-03') process.exit(3);
const id = p.result?.verifiedSnapshot?.snapshotId;
if (!id) process.exit(4);
if (Buffer.byteLength(JSON.stringify(p),'utf8') >= 90000) process.exit(5);
console.log(id);
NODE
)" || die "getDealStatus response contract failed"
echo "SNAPSHOT_ID=$SNAPSHOT_ID"

time_file=/tmp/bbc-actions-snapshot.time
snapshot_code="$(curl -sS -o /tmp/bbc-actions-snapshot.json -w '%{http_code}' \
  -X POST "$BASE_URL/actions/get-verified-snapshot" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GPT_ACTION_KEY" \
  --data "{\"snapshotId\":\"$SNAPSHOT_ID\"}")"
echo "SNAPSHOT_HTTP=$snapshot_code"
[ "$snapshot_code" = "200" ] || die "Authorized getVerifiedSnapshot failed"
node <<'NODE'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('/tmp/bbc-actions-snapshot.json','utf8'));
if (p.ok !== true || p.action !== 'getVerifiedSnapshot') process.exit(2);
if (p.result?.contourVersion !== '1.0.5-rc-corr-03' || p.result?.found !== true) process.exit(3);
const snapshot = p.result?.snapshot;
if (!snapshot?.snapshotId || snapshot.canonicalPayload || snapshot.calculationResult) process.exit(4);
if (Buffer.byteLength(JSON.stringify(p),'utf8') >= 90000) process.exit(5);
console.log('VERIFIED_SNAPSHOT_SUMMARY_GATE=PASS');
NODE

printf '%s\n' "[10/10] Consequential transport/runtime gate on already-approved control Snapshot"
GENERATE_KEY="ACTIONS-RC-01-CONTROL-GENERATE-20260820"
set +e
generate_metrics="$(curl --max-time 44 -sS -o /tmp/bbc-actions-generate.json -w '%{http_code} %{time_total}' \
  -X POST "$BASE_URL/actions/generate-quote" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GPT_ACTION_KEY" \
  --data "{\"snapshotId\":\"$SNAPSHOT_ID\",\"idempotencyKey\":\"$GENERATE_KEY\",\"outputProfile\":\"FULL_MASTER_WORKBOOK\"}")"
curl_rc=$?
set -e
[ "$curl_rc" = "0" ] || die "generateQuote exceeded 44 seconds or transport failed; idempotency key is safe to retry"
generate_code="$(printf '%s' "$generate_metrics" | awk '{print $1}')"
generate_seconds="$(printf '%s' "$generate_metrics" | awk '{print $2}')"
echo "GENERATE_HTTP=$generate_code"
echo "GENERATE_SECONDS=$generate_seconds"
[ "$generate_code" = "200" ] || { cat /tmp/bbc-actions-generate.json; die "generateQuote Action failed"; }
awk -v t="$generate_seconds" 'BEGIN { exit !(t < 40.0) }' || die "generateQuote transport runtime is not below the 40-second safety gate"
node <<'NODE'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('/tmp/bbc-actions-generate.json','utf8'));
if (p.ok !== true || p.action !== 'generateQuote' || p.actionBridgeVersion !== 'ACTIONS-RC-01') process.exit(2);
const r = p.result || {};
if (r.contourVersion !== '1.0.5-rc-corr-03') process.exit(3);
if (r.quoteContextSource !== 'SNAPSHOT_V2') process.exit(4);
if (r.rawImportReadsAfterSnapshot !== 0) process.exit(5);
if (r.recalculationAfterSnapshot !== false) process.exit(6);
if (r.outputProfile !== 'FULL_MASTER_WORKBOOK') process.exit(7);
if (!r.files?.googleSheets?.url || !r.files?.xlsx?.url || !r.files?.pdf?.url) process.exit(8);
if (Buffer.byteLength(JSON.stringify(p),'utf8') >= 90000) process.exit(9);
console.log('SNAPSHOT_BOUND_QUOTE_GATE=PASS');
console.log('GOOGLE_SHEETS=' + r.files.googleSheets.url);
console.log('XLSX=' + r.files.xlsx.url);
console.log('PDF=' + r.files.pdf.url);
NODE

echo
echo "MCP_BASE_RELEASE=$EXPECTED_MCP_RELEASE"
echo "ACTION_BRIDGE=$EXPECTED_ACTION_BRIDGE"
echo "BACKEND_CONTOUR=$EXPECTED_CONTOUR"
echo "ACTION_KEY_FILE=$KEY_FILE"
echo "RESULT=ACTIONS-RC-01_STAGING_LIVE_ACCEPTANCE_PASS"
