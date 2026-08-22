#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

TARGET_WORKER="bbc-quote-mcp-server-staging"
BASE_URL="https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev"
EXPECTED_ACTION_BRIDGE="ACTIONS-RC-02"
EXPECTED_MCP_RELEASE="RC-CORR-06C"
EXPECTED_CONTOUR="1.0.5-rc-corr-03"
CONFIG="wrangler.contour.jsonc"

EXPECTED_CONTOUR_SHA="9a89ada3889ccf327c5dc0d9ac69e4603c55f31f19b8168911d843f09316151d"
EXPECTED_BRIDGE_SHA="22e6186327f991966b475a28a41b44064649176eb9ecf1def9a0d3ffb23457f1"
EXPECTED_OPENAPI_SHA="2b57e33efc389d859b2103a3e4463278ba7354ef56fcfb159939110bab02b8ca"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

need node
need npm
need npx
need curl
need shasum
need awk
need grep

printf '%s\n' "=== ACTIONS-RC-02 CANONICAL JSON TRANSPORT — STAGING ONLY ==="
printf '%s\n' "[1/9] Verify exact staging target and patched sources"

grep -q '"name"[[:space:]]*:[[:space:]]*"bbc-quote-mcp-server-staging"' "$CONFIG" || fail "Wrong Worker target"
grep -q '"main"[[:space:]]*:[[:space:]]*"src/staging-contour-rc.js"' "$CONFIG" || fail "Wrong Worker entrypoint"
if grep -q '"name"[[:space:]]*:[[:space:]]*"bbc-quote-mcp-server"[[:space:]]*[,}]' "$CONFIG"; then
  fail "Production Worker target detected"
fi

actual_contour_sha="$(shasum -a 256 src/staging-contour-rc.js | awk '{print $1}')"
actual_bridge_sha="$(shasum -a 256 src/action-bridge.js | awk '{print $1}')"
actual_openapi_sha="$(shasum -a 256 openapi-actions.yaml | awk '{print $1}')"
[ "$actual_contour_sha" = "$EXPECTED_CONTOUR_SHA" ] || fail "staging-contour-rc.js SHA mismatch"
[ "$actual_bridge_sha" = "$EXPECTED_BRIDGE_SHA" ] || fail "action-bridge.js SHA mismatch"
[ "$actual_openapi_sha" = "$EXPECTED_OPENAPI_SHA" ] || fail "openapi-actions.yaml SHA mismatch"
echo "SOURCE_GUARD=PASS"

printf '%s\n' "[2/9] Ensure dependencies and run regression suite"
if [ ! -x node_modules/.bin/wrangler ] && [ -x "$HOME/Downloads/bbc-actions-rc01-final/node_modules/.bin/wrangler" ]; then
  ln -s "$HOME/Downloads/bbc-actions-rc01-final/node_modules" node_modules
  echo "DEPENDENCIES=REUSED_FROM_RC01"
fi
if [ ! -x node_modules/.bin/wrangler ]; then
  npm ci --no-audit --no-fund
  echo "DEPENDENCIES=INSTALLED"
fi
node --check src/action-bridge.js
node --check src/staging-contour-rc.js
npm test
echo "REGRESSION_SUITE=PASS"

printf '%s\n' "[3/9] Wrangler staging dry-run"
npx wrangler deploy --dry-run -c "$CONFIG" >/tmp/bbc-actions-rc02-dry-run.log 2>&1 || {
  cat /tmp/bbc-actions-rc02-dry-run.log
  fail "Wrangler dry-run failed"
}
echo "WRANGLER_DRY_RUN=PASS"

printf '%s\n' "[4/9] Reuse and verify the existing GPT Action key — no secret rotation"
KEY_FILE=""
for candidate in \
  "/tmp/bbc-gpt-action-key" \
  "$HOME/Downloads/bbc-actions-rc01-final/.gpt_action_key.staging" \
  "$ROOT_DIR/.gpt_action_key.staging"
do
  [ -s "$candidate" ] || continue
  candidate_key="$(tr -d '\r\n' < "$candidate")"
  [ "${#candidate_key}" -ge 40 ] || continue
  code="$(curl -sS -o /tmp/bbc-actions-rc02-preauth.json -w '%{http_code}' \
    -X POST "$BASE_URL/actions/validate-canonical-deal" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $candidate_key" \
    --data-binary '{"canonicalDeal":{}}' || true)"
  unset candidate_key
  if [ "$code" = "200" ]; then
    KEY_FILE="$candidate"
    break
  fi
done
[ -n "$KEY_FILE" ] || fail "Existing GPT Action key could not be verified. No secret was changed."
echo "EXISTING_GPT_ACTION_KEY=VERIFIED"
echo "SECRET_MUTATION=NONE"

GPT_ACTION_KEY="$(tr -d '\r\n' < "$KEY_FILE")"

printf '%s\n' "[5/9] Deploy patched bridge to isolated staging Worker"
npx wrangler deploy -c "$CONFIG" 2>&1 | tee /tmp/bbc-actions-rc02-deploy.log

printf '%s\n' "[6/9] Poll live health identity"
health_pass=0
for i in $(seq 1 24); do
  curl -fsS -H 'cache-control: no-cache' "$BASE_URL/health?actions_rc02=$i-$(date +%s)" -o /tmp/bbc-actions-rc02-health.json || true
  if node <<'NODE'
const fs = require('fs');
let h;
try { h = JSON.parse(fs.readFileSync('/tmp/bbc-actions-rc02-health.json','utf8')); } catch { process.exit(1); }
const expected = ['generateQuote','getDealStatus','getVerifiedSnapshot','recalculateDeal','validateCanonicalDeal'].sort();
const actions = Array.isArray(h.actionContract) ? [...h.actionContract].sort() : [];
const tools = Array.isArray(h.toolContract) ? [...h.toolContract].sort() : [];
const ok = h.ok === true &&
  h.releaseId === 'RC-CORR-06C' &&
  h.contourVersion === '1.0.5-rc-corr-03' &&
  h.actionBridgeVersion === 'ACTIONS-RC-02' &&
  h.actionAuthMode === 'BEARER_API_KEY' &&
  h.actionConfigured === true &&
  h.actionBodyMaxBytes === 90000 &&
  h.actionResponseMaxBytes === 90000 &&
  JSON.stringify(actions) === JSON.stringify(expected) &&
  JSON.stringify(tools) === JSON.stringify(expected);
if (!ok) process.exit(1);
console.log('HEALTH_ACTION_BRIDGE=PASS');
console.log('WORKER_VERSION=' + String(h.workerVersion?.id || 'unknown'));
NODE
  then
    health_pass=1
    break
  fi
  sleep 5
done
[ "$health_pass" = "1" ] || fail "Live health did not converge to ACTIONS-RC-02"

printf '%s\n' "[7/9] Security gate: unauthenticated Action must still fail closed"
unauth_code="$(curl -sS -o /tmp/bbc-actions-rc02-unauth.json -w '%{http_code}' \
  -X POST "$BASE_URL/actions/validate-canonical-deal" \
  -H 'content-type: application/json' \
  --data-binary '{"canonicalDealJson":"{}"}')"
[ "$unauth_code" = "401" ] || fail "Unauthenticated Action was not rejected with HTTP 401"
grep -q '"UNAUTHORIZED"' /tmp/bbc-actions-rc02-unauth.json || fail "Unauthorized response contract mismatch"
echo "UNAUTHENTICATED_ACTION_GATE=PASS"

printf '%s\n' "[8/9] Authorized canonicalDealJson transport probe"
probe_code="$(curl -sS -o /tmp/bbc-actions-rc02-probe.json -w '%{http_code}' \
  -X POST "$BASE_URL/actions/validate-canonical-deal" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GPT_ACTION_KEY" \
  --data-binary '{"canonicalDealJson":"{}"}')"
unset GPT_ACTION_KEY
[ "$probe_code" = "200" ] || { cat /tmp/bbc-actions-rc02-probe.json; fail "canonicalDealJson probe did not reach backend"; }
node <<'NODE'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('/tmp/bbc-actions-rc02-probe.json','utf8'));
if (p.ok !== true) process.exit(2);
if (p.action !== 'validateCanonicalDeal') process.exit(3);
if (p.actionBridgeVersion !== 'ACTIONS-RC-02') process.exit(4);
if (p.result?.contourVersion !== '1.0.5-rc-corr-03') process.exit(5);
if (p.result?.schemaOk !== false) process.exit(6);
const issues = Array.isArray(p.result?.schemaIssues) ? p.result.schemaIssues : [];
if (!issues.some((x) => x?.path === 'canonicalId')) process.exit(7);
const text = JSON.stringify(p);
if (text.includes('canonicalDeal must be an object')) process.exit(8);
console.log('CANONICAL_JSON_TRANSPORT=PASS');
console.log('BACKEND_OBJECT_PARSE=PASS');
NODE

printf '%s\n' "[9/9] Prepare the exact OpenAPI schema for immediate paste into Custom GPT"
if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < openapi-actions.yaml
  echo "OPENAPI_COPIED_TO_CLIPBOARD=YES"
else
  echo "OPENAPI_COPIED_TO_CLIPBOARD=NO"
fi

echo
echo "TARGET_WORKER=$TARGET_WORKER"
echo "MCP_BASE_RELEASE=$EXPECTED_MCP_RELEASE"
echo "ACTION_BRIDGE=$EXPECTED_ACTION_BRIDGE"
echo "BACKEND_CONTOUR=$EXPECTED_CONTOUR"
echo "GPT_ACTION_KEY=REUSED_UNCHANGED"
echo "RESULT=ACTIONS-RC-02_STAGING_TRANSPORT_PASS"
