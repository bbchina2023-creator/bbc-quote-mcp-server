import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const contour = fs.readFileSync(new URL("../src/staging-contour.js", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../wrangler.contour.jsonc", import.meta.url), "utf8");
const durableObject = fs.readFileSync(new URL("../src/oauth-state-do.js", import.meta.url), "utf8");

test("custom one-time OAuth state no longer uses OAUTH_KV", () => {
  assert.doesNotMatch(contour, /createConsentRecord\(env\.OAUTH_KV/);
  assert.doesNotMatch(contour, /consumeConsentRecord\(env\.OAUTH_KV/);
  assert.doesNotMatch(contour, /env\.OAUTH_KV\.(?:put|get|delete)\(/);
  assert.match(contour, /createConsentRecord\(env\.OAUTH_STATE/);
  assert.match(contour, /createGitHubStateRecord\(env\.OAUTH_STATE/);
  assert.match(contour, /consumeGitHubStateRecord\(env\.OAUTH_STATE/);
});

test("OAuth provider KV remains configured while one-time state gets its own DO binding", () => {
  assert.match(config, /"binding"\s*:\s*"OAUTH_KV"/);
  assert.match(config, /"name"\s*:\s*"OAUTH_STATE"/);
  assert.match(config, /"class_name"\s*:\s*"OAuthStateDurableObject"/);
  assert.match(config, /"exports"\s*:/);
  assert.match(config, /"storage"\s*:\s*"sqlite"/);
});

test("entrypoint exports the Durable Object class", () => {
  assert.match(contour, /export \{ OAuthStateDurableObject \} from "\.\/oauth-state-do\.js";/);
  assert.match(durableObject, /export class OAuthStateDurableObject extends DurableObject/);
});

test("health contract advertises Durable Object one-time state", () => {
  assert.match(contour, /DURABLE_OBJECT_ONE_TIME_STATE_V1/);
  assert.match(contour, /OAUTH_STATE_DURABLE_OBJECT/);
});
