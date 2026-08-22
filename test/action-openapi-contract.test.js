import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const schema = fs.readFileSync(new URL("../openapi-actions.yaml", import.meta.url), "utf8");
const contour = fs.readFileSync(new URL("../src/staging-contour-rc.js", import.meta.url), "utf8");
const wrangler = fs.readFileSync(new URL("../wrangler.contour.jsonc", import.meta.url), "utf8");

test("OpenAPI schema advertises exactly the five final Action operationIds", () => {
  const ids = [...schema.matchAll(/^\s+operationId:\s*([^\s]+)\s*$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [
    "validateCanonicalDeal",
    "recalculateDeal",
    "getVerifiedSnapshot",
    "generateQuote",
    "getDealStatus",
  ].sort());
});

test("OpenAPI schema is staging-only and Bearer authenticated", () => {
  assert.match(schema, /https:\/\/bbc-quote-mcp-server-staging\.bbchina2023\.workers\.dev/);
  assert.match(schema, /bearerAuth:/);
  assert.match(schema, /scheme:\s*bearer/);
  assert.doesNotMatch(schema, /production/i);
});

test("full Snapshot payload is not exposed in the GPT Action contract", () => {
  assert.doesNotMatch(schema, /includePayload/);
  assert.match(schema, /Full snapshot payload is intentionally not exposed/);
});

test("Worker routes Actions before MCP and keeps RC-CORR-06C MCP identity", () => {
  assert.match(contour, /ACTION_ROUTE_TO_BACKEND\[url\.pathname\]/);
  assert.match(contour, /if \(action\) return handleActionRequest/);
  assert.match(contour, /RELEASE_ID = "RC-CORR-06C"/);
  assert.match(contour, /ACTION_BRIDGE_VERSION/);
});

test("staging config requires a separate GPT_ACTION_KEY secret", () => {
  assert.match(wrangler, /GPT_ACTION_KEY/);
  assert.match(wrangler, /"name": "bbc-quote-mcp-server-staging"/);
});

test("Custom GPT canonical transport is a bounded JSON string, not a nested free-form object", () => {
  const validateBlock = schema.match(/\/actions\/validate-canonical-deal:[\s\S]*?\/actions\/recalculate-deal:/)?.[0] || "";
  const recalcBlock = schema.match(/\/actions\/recalculate-deal:[\s\S]*?\/actions\/get-verified-snapshot:/)?.[0] || "";
  for (const block of [validateBlock, recalcBlock]) {
    assert.match(block, /canonicalDealJson:/);
    assert.match(block, /type:\s*string/);
    assert.match(block, /maxLength:\s*85000/);
    assert.doesNotMatch(block, /\n\s+canonicalDeal:\s*\n\s+type:\s*object/);
  }
});

