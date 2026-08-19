import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const contour = fs.readFileSync(new URL("../src/staging-contour.js", import.meta.url), "utf8");
const defaultConfig = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const contourConfig = fs.readFileSync(new URL("../wrangler.contour.jsonc", import.meta.url), "utf8");
const durableObject = fs.readFileSync(new URL("../src/oauth-state-do.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function assertReleaseCConfig(config) {
  assert.match(config, /"name"\s*:\s*"bbc-quote-mcp-server-staging"/);
  assert.match(config, /"main"\s*:\s*"src\/staging-contour\.js"/);
  assert.match(config, /"binding"\s*:\s*"OAUTH_KV"/);
  assert.match(config, /"name"\s*:\s*"OAUTH_STATE"/);
  assert.match(config, /"class_name"\s*:\s*"OAuthStateDurableObject"/);
  assert.match(config, /"exports"\s*:/);
  assert.match(config, /"storage"\s*:\s*"sqlite"/);
  assert.match(config, /"version_metadata"\s*:/);
  assert.match(config, /"binding"\s*:\s*"CF_VERSION_METADATA"/);
  assert.match(config, /"secrets"\s*:/);
  assert.match(config, /"required"\s*:\s*\[\s*"GITHUB_CLIENT_SECRET"\s*,\s*"BBC_BACKEND_URL"\s*,\s*"BBC_BACKEND_TOKEN"\s*\]/);
  assert.match(config, /global_fetch_strictly_public/);
  assert.doesNotMatch(config, /"migrations"\s*:/);
}

test("custom one-time OAuth state no longer uses OAUTH_KV", () => {
  assert.doesNotMatch(contour, /createConsentRecord\(env\.OAUTH_KV/);
  assert.doesNotMatch(contour, /consumeConsentRecord\(env\.OAUTH_KV/);
  assert.doesNotMatch(contour, /env\.OAUTH_KV\.(?:put|get|delete)\(/);
  assert.match(contour, /createConsentRecord\(env\.OAUTH_STATE/);
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

test("health contract advertises Durable Object one-time state and Worker version metadata", () => {
  assert.match(contour, /DURABLE_OBJECT_ONE_TIME_STATE_V1/);
  assert.match(contour, /OAUTH_STATE_DURABLE_OBJECT/);
  assert.match(contour, /CF_VERSION_METADATA/);
  assert.match(contour, /releaseId:\s*RELEASE_ID/);
});

test("ChatGPT OAuth client compatibility is pinned to the verified provider generation", () => {
  assert.equal(pkg.dependencies["@cloudflare/workers-oauth-provider"], "0.10.3");
  assert.match(contour, /clientIdMetadataDocumentEnabled:\s*true/);
  assert.match(contour, /clientRegistrationEndpoint:\s*"\/oauth\/register"/);
});
