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

test("canonical validation accepts the attached object and recalculation consumes only its validated reference", () => {
  const validateBlock = contour.slice(
    contour.indexOf('server.registerTool(\n    "validateCanonicalDeal"'),
    contour.indexOf('server.registerTool(\n    "recalculateDeal"'),
  );
  const recalculateBlock = contour.slice(
    contour.indexOf('server.registerTool(\n    "recalculateDeal"'),
    contour.indexOf('server.registerTool(\n    "getVerifiedSnapshot"'),
  );
  assert.match(validateBlock, /canonicalDeal: canonicalDealSchema/);
  assert.doesNotMatch(validateBlock, /canonicalDealJson/);
  assert.match(validateBlock, /validatedCanonicalRef/);
  assert.match(recalculateBlock, /validatedCanonicalRef: z\.string\(\)\.regex/);
  assert.doesNotMatch(recalculateBlock, /canonicalDealJson|canonicalDeal: canonicalDealSchema/);
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

test("RC-CORR-06C publishes root securitySchemes and in-band OAuth challenges", () => {
  assert.match(contour, /SERVER_VERSION = "1\.0\.5-rc-corr-06c-staging"/);
  assert.match(contour, /RELEASE_ID = "RC-CORR-06C"/);
  assert.match(contour, /MCP_AUTH_MODE = "PUBLIC_DISCOVERY_ROOT_SECURITY_SCHEMES_INBAND_OAUTH_V3"/);
  assert.match(contour, /"mcp\/www_authenticate": \[challenge\]/);
  assert.match(contour, /error="insufficient_scope"/);
  assert.match(contour, /error_description=/);
  assert.match(contour, /tool\.securitySchemes = schemes/);
  assert.match(contour, /tool\._meta = \{ \.\.\.\(tool\._meta \|\| \{\}\), securitySchemes: schemes \}/);
  assert.match(contour, /if \(!hasToolScope\(effectiveScopes, "quote\.read"\)\) return oauthToolChallenge\("quote\.read"\)/);
  assert.match(contour, /if \(!hasToolScope\(effectiveScopes, "quote\.write"\)\) return oauthToolChallenge\("quote\.write"\)/);
  assert.match(contour, /if \(!hasToolScope\(effectiveScopes, "quote\.generate"\)\) return oauthToolChallenge\("quote\.generate"\)/);
  assert.doesNotMatch(contour, /mcpPayloadRequiresAuthorization/);
  assert.match(contour, /tokenAudienceMatches\(tokenSummary\)/);
});
