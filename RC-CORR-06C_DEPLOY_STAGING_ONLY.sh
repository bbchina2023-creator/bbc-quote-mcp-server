#!/bin/bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"

ENDPOINT="https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev/mcp"
HEALTH="https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev/health"
EXPECTED_SOURCE_SHA="e40559e409485517c666984579c0eab5b90805f5f9cad59cf4c8f729408a401e"
EVIDENCE="$ROOT/RC-CORR-06C_DEPLOY_EVIDENCE.txt"

exec > >(tee "$EVIDENCE") 2>&1

echo "BBC KP Generator RC-CORR-06C staging-only deploy"
echo "Started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

echo "[1/9] Safety gate: exact staging target"
grep -q '"name": "bbc-quote-mcp-server-staging"' wrangler.contour.jsonc
grep -q '"main": "src/staging-contour-rc.js"' wrangler.contour.jsonc
if grep -q '"name": "bbc-quote-mcp-server"[[:space:]]*[,}]' wrangler.contour.jsonc; then
  echo "ABORT: production Worker target detected in staging config"
  exit 20
fi

echo "[2/9] Source identity"
ACTUAL_SOURCE_SHA="$(shasum -a 256 src/staging-contour-rc.js | awk '{print $1}')"
if [ "$ACTUAL_SOURCE_SHA" != "$EXPECTED_SOURCE_SHA" ]; then
  echo "ABORT: source SHA mismatch: $ACTUAL_SOURCE_SHA"
  exit 21
fi
echo "source_sha256=$ACTUAL_SOURCE_SHA"

echo "[3/9] Exact dependency install from committed lockfile"
npm ci --ignore-scripts

echo "[4/9] Syntax and targeted RC-CORR-06/OAuth regression"
node --check src/staging-contour-rc.js
node --test test/oauth-security.test.js test/release-c-chatgpt-oauth-contract.test.js test/release-c-do-wiring.test.js

echo "[5/9] Wrangler staging dry-run"
npx wrangler deploy --dry-run -c wrangler.contour.jsonc

echo "[6/9] Direct deploy to isolated staging Worker only"
npx wrangler deploy -c wrangler.contour.jsonc

sleep 3

echo "[7/9] Live health identity"
curl -fsS "$HEALTH" | tee /tmp/bbc-rc06-health.json
grep -q '"releaseId":"RC-CORR-06C"' /tmp/bbc-rc06-health.json || grep -q '"releaseId": "RC-CORR-06C"' /tmp/bbc-rc06-health.json
grep -q '"mcpAuthMode":"PUBLIC_DISCOVERY_ROOT_SECURITY_SCHEMES_INBAND_OAUTH_V3"' /tmp/bbc-rc06-health.json || grep -q '"mcpAuthMode": "PUBLIC_DISCOVERY_ROOT_SECURITY_SCHEMES_INBAND_OAUTH_V3"' /tmp/bbc-rc06-health.json

echo "[8/9] Live anonymous MCP discovery"
INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"bbc-rc06-postdeploy","version":"1.0"}}}'
TOOLS_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

INIT_CODE="$(curl -sS -o /tmp/bbc-rc06-init.out -w '%{http_code}' -X POST "$ENDPOINT" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$INIT_BODY")"
if [ "$INIT_CODE" != "200" ]; then
  echo "ABORT: anonymous initialize returned HTTP $INIT_CODE"
  cat /tmp/bbc-rc06-init.out
  exit 22
fi

TOOLS_CODE="$(curl -sS -o /tmp/bbc-rc06-tools.out -w '%{http_code}' -X POST "$ENDPOINT" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$TOOLS_BODY")"
if [ "$TOOLS_CODE" != "200" ]; then
  echo "ABORT: anonymous tools/list returned HTTP $TOOLS_CODE"
  cat /tmp/bbc-rc06-tools.out
  exit 23
fi
node - /tmp/bbc-rc06-tools.out <<'NODE'
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8");
const jsonCandidates = [];
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed.startsWith("data:")) jsonCandidates.push(trimmed.slice(5).trim());
}
if (raw.trim().startsWith("{")) jsonCandidates.push(raw.trim());
let payload = null;
for (const candidate of jsonCandidates) {
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed?.result?.tools)) { payload = parsed; break; }
  } catch {}
}
if (!payload) {
  console.error("ABORT: tools/list response could not be parsed");
  console.error(raw);
  process.exit(24);
}
const expectedScopes = {
  validateCanonicalDeal: "quote.read",
  recalculateDeal: "quote.write",
  getVerifiedSnapshot: "quote.read",
  generateQuote: "quote.generate",
  getDealStatus: "quote.read",
};
const actual = payload.result.tools.map((tool) => tool.name).sort();
const expected = Object.keys(expectedScopes).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("ABORT: tool contract mismatch");
  console.error("actual=" + JSON.stringify(actual));
  console.error("expected=" + JSON.stringify(expected));
  process.exit(25);
}
for (const tool of payload.result.tools) {
  const requiredScope = expectedScopes[tool.name];
  const rootSchemes = tool.securitySchemes;
  const metaSchemes = tool?._meta?.securitySchemes;
  const valid = (schemes) => Array.isArray(schemes) && schemes.length === 1 && schemes[0]?.type === "oauth2" && Array.isArray(schemes[0]?.scopes) && schemes[0].scopes.length === 1 && schemes[0].scopes[0] === requiredScope;
  if (!valid(rootSchemes) || !valid(metaSchemes)) {
    console.error("ABORT: securitySchemes mismatch for " + tool.name);
    console.error(JSON.stringify({ rootSchemes, metaSchemes, requiredScope }));
    process.exit(27);
  }
}
console.log("tool_contract=" + JSON.stringify(actual));
console.log("root_security_schemes=PASS");
NODE
echo "anonymous_tools_list=PASS_EXACT_FIVE_WITH_ROOT_SECURITY_SCHEMES"

echo "[9/9] Live unauthenticated tool execution must return an in-band MCP OAuth challenge"
CALL_BODY='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"getDealStatus","arguments":{"dealId":"BBC-15af9054-0cfd-414e-b0c9-90a50ac6d2a6"}}}'
CALL_CODE="$(curl -sS -o /tmp/bbc-rc06c-call.out -w '%{http_code}' -X POST "$ENDPOINT" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$CALL_BODY")"
if [ "$CALL_CODE" != "200" ]; then
  echo "ABORT: unauthenticated tools/call returned HTTP $CALL_CODE, expected MCP in-band 200 challenge"
  cat /tmp/bbc-rc06c-call.out
  exit 26
fi
node - /tmp/bbc-rc06c-call.out <<'NODE'
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8");
let payload = null;
for (const line of raw.split(/\r?\n/)) {
  const s = line.trim();
  if (!s.startsWith("data:")) continue;
  try {
    const p = JSON.parse(s.slice(5).trim());
    if (p?.result) { payload = p; break; }
  } catch {}
}
if (!payload?.result?.isError) { console.error(raw); throw new Error("Expected isError OAuth challenge result"); }
const meta = payload.result._meta || {};
const challenge = meta["mcp/www_authenticate"];
if (!Array.isArray(challenge) || !challenge.some((x) => {
  const text = String(x);
  return text.includes("resource_metadata=") && text.includes("scope=\"quote.read\"") && text.includes("error=\"insufficient_scope\"") && text.includes("error_description=");
})) {
  console.error(raw);
  throw new Error("mcp/www_authenticate challenge missing or malformed");
}
console.log("inband_oauth_challenge=PASS");
NODE
echo "RESULT=RC-CORR-06C_STAGING_DEPLOYED_AND_CHATGPT_TOOL_METADATA_GATE_PASS"
echo "Finished: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
