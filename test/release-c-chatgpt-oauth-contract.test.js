import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const contour = fs.readFileSync(new URL("../src/staging-contour-rc.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const expectedTools = [
  "validateCanonicalDeal",
  "recalculateDeal",
  "getVerifiedSnapshot",
  "generateQuote",
  "getDealStatus",
];

test("Release C exposes exactly the five final manager-facing tools", () => {
  const tools = [...contour.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tools, expectedTools);
  for (const legacy of ["startDealFromFiles", "submitManagerAnswers", "getDealPackage"]) {
    assert.equal(tools.includes(legacy), false);
  }
});

test("ChatGPT OAuth discovery advertises refresh-capable offline access without polluting resource scopes", () => {
  assert.equal(pkg.dependencies["@cloudflare/workers-oauth-provider"], "0.10.3");
  assert.match(contour, /export const RESOURCE_SCOPES = \["quote\.read", "quote\.write", "quote\.generate"\];/);
  assert.match(contour, /export const SUPPORTED_SCOPES = \[\.\.\.RESOURCE_SCOPES, "offline_access"\];/);
  assert.match(contour, /scopesSupported:\s*SUPPORTED_SCOPES/);
  assert.match(contour, /resourceMetadata:[\s\S]*scopes_supported:\s*RESOURCE_SCOPES/);
  assert.match(contour, /refreshTokenTTL:\s*2592000/);
  assert.match(contour, /clientIdMetadataDocumentEnabled:\s*true/);
  assert.match(contour, /clientRegistrationEndpoint:\s*"\/oauth\/register"/);
});

test("authorization grants preserve offline_access when requested", () => {
  assert.match(contour, /requestedScopes\.filter\(\(scope\) => SUPPORTED_SCOPES\.includes\(scope\)\)/);
});
