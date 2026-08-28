import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const contour = fs.readFileSync(new URL("../src/staging-contour-rc.js", import.meta.url), "utf8");
const canonicalSchema = fs.readFileSync(new URL("../src/canonical-schema.js", import.meta.url), "utf8");
const defaultConfig = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const contourConfig = fs.readFileSync(new URL("../wrangler.contour.jsonc", import.meta.url), "utf8");
const durableObject = fs.readFileSync(new URL("../src/oauth-state-do.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function assertReleaseCConfig(config) {
  assert.match(config, /"name"\s*:\s*"bbc-quote-mcp-server-staging"/);
  assert.match(config, /"main"\s*:\s*"src\/staging-contour-rc\.js"/);
  assert.match(config, /"binding"\s*:\s*"OAUTH_KV"/);
  assert.match(config, /"name"\s*:\s*"OAUTH_STATE"/);
  assert.match(config, /"class_name"\s*:\s*"OAuthStateDurableObject"/);
  assert.match(config, /"exports"\s*:/);
  assert.match(config, /"storage"\s*:\s*"sqlite"/);
  assert.match(config, /"version_metadata"\s*:/);
  assert.match(config, /"binding"\s*:\s*"CF_VERSION_METADATA"/);
  assert.match(config, /"secrets"\s*:/);
  assert.match(config, /"required"\s*:\s*\[\s*"GITHUB_CLIENT_SECRET"\s*,\s*"BBC_BACKEND_URL"\s*,\s*"BBC_BACKEND_TOKEN"\s*,\s*"GPT_ACTION_KEY"\s*\]/);
  assert.match(config, /global_fetch_strictly_public/);
  assert.doesNotMatch(config, /"migrations"\s*:/);
}

test("browser-bound GitHub OAuth state uses the Durable Object, never OAUTH_KV", () => {
  assert.doesNotMatch(contour, /createConsentRecord\(env\.OAUTH_KV/);
  assert.doesNotMatch(contour, /consumeConsentRecord\(env\.OAUTH_KV/);
  assert.doesNotMatch(contour, /env\.OAUTH_KV\.(?:put|get|delete)\(/);
  assert.doesNotMatch(contour, /createConsentRecord\(/);
  assert.doesNotMatch(contour, /consumeConsentRecord\(/);
  assert.match(contour, /createGitHubStateRecord\(env\.OAUTH_STATE/);
  assert.match(contour, /consumeGitHubStateRecord\(env\.OAUTH_STATE/);
});

test("default Cloudflare build config has the complete Release C contract", () => {
  assertReleaseCConfig(defaultConfig);
});

test("explicit contour config has the same complete Release C contract", () => {
  assertReleaseCConfig(contourConfig);
});

test("entrypoint exports the Durable Object class", () => {
  assert.match(contour, /export \{ OAuthStateDurableObject \} from "\.\/oauth-state-do\.js";/);
  assert.match(durableObject, /export class OAuthStateDurableObject extends DurableObject/);
});

test("MCP canonical transport is bounded JSON text and strict schema remains regression-tested", () => {
  assert.match(contour, /canonicalDealJson: z\.string\(\)\.min\(2\)\.max\(ACTION_BODY_MAX_BYTES - 1024\)/);
  assert.match(contour, /normalizeActionArguments/);
  assert.doesNotMatch(contour, /z\.record\(z\.string\(\), z\.unknown\(\)\)/);
  assert.match(canonicalSchema, /canonicalId:\s*z\.string\(\)\.min\(1\)/);
  assert.match(canonicalSchema, /paymentSchedules:\s*z\.array\(paymentScheduleSchema\)/);
  assert.match(canonicalSchema, /managerDecisions:\s*z\.array\(managerDecisionSchema\)/);
  assert.match(canonicalSchema, /fieldMeta:\s*z\.array\(fieldMetaSchema\)/);
  assert.match(canonicalSchema, /lineage:\s*z\.array\(lineageEvidenceSchema\)/);
});

test("backend authentication uses a separate body token secret", () => {
  assert.match(contour, /BBC_BACKEND_TOKEN/);
  assert.match(contour, /JSON\.stringify\(\{ action, arguments: args, backendToken \}\)/);
  assert.doesNotMatch(contour, /searchParams\.set\([^\n]*token/i);
});

test("MCP discovery stays public and tools/list promotes first-class OAuth securitySchemes", () => {
  assert.match(contour, /oauthToolChallenge/);
  assert.match(contour, /"mcp\/www_authenticate": \[challenge\]/);
  assert.match(contour, /resource_metadata="\$\{MCP_RESOURCE_METADATA\}"/);
  assert.match(contour, /tool\.securitySchemes = schemes/);
  assert.match(contour, /tool\._meta = \{ \.\.\.\(tool\._meta \|\| \{\}\), securitySchemes: schemes \}/);
  assert.match(contour, /error="insufficient_scope"/);
  assert.match(contour, /url\.pathname === "\/mcp"/);
  assert.doesNotMatch(contour, /apiRoute:\s*"\/mcp"/);
  assert.match(contour, /apiRoute:\s*"\/__oauth_provider_internal_sentinel"/);
  assert.match(contour, /apiHandler:\s*oauthProviderSentinelHandler/);
});

test("per-tool scopes come from a validated resource-bound OAuth access token", () => {
  assert.match(contour, /OAUTH_PROVIDER\.unwrapToken\(match\[1\]\)/);
  assert.match(contour, /Array\.isArray\(tokenSummary\.scope\)/);
  assert.match(contour, /tokenAudienceMatches\(tokenSummary\)/);
  assert.match(contour, /createServer\(env, auth\.scopes\)/);
  assert.match(contour, /hasToolScope\(effectiveScopes, "quote\.read"\)/);
  assert.match(contour, /hasToolScope\(effectiveScopes, "quote\.write"\)/);
  assert.match(contour, /hasToolScope\(effectiveScopes, "quote\.generate"\)/);
  assert.doesNotMatch(contour, /extra\?\.authInfo\?\.scopes/);
  assert.doesNotMatch(contour, /resourceScopes/);
});

test("health contract advertises Durable Object state and Worker version metadata", () => {
  assert.match(contour, /DIRECT_GITHUB_REDIRECT_STATE_BOUND_V3/);
  assert.match(contour, /OAUTH_STATE_DURABLE_OBJECT/);
  assert.match(contour, /CF_VERSION_METADATA/);
  assert.match(contour, /releaseId:\s*RELEASE_ID/);
  assert.match(contour, /workerEntrypoint:\s*"src\/staging-contour-rc\.js"/);
});

test("authorization starts GitHub directly without the fragile intermediate consent POST", () => {
  assert.match(contour, /beginGitHubAuthorization/);
  assert.match(contour, /oauth\.authorize\.redirect\.github/);
  assert.doesNotMatch(contour, /CSRF validation failed/);
  assert.doesNotMatch(contour, /name="consent_id"/);
  assert.doesNotMatch(contour, /handleAuthorizationConsent/);
});

test("ChatGPT OAuth client compatibility is pinned to the verified provider generation", () => {
  assert.equal(pkg.dependencies["@cloudflare/workers-oauth-provider"], "0.10.3");
  assert.match(contour, /clientIdMetadataDocumentEnabled:\s*true/);
  assert.match(contour, /clientRegistrationEndpoint:\s*"\/oauth\/register"/);
});
