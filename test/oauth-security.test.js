import test from "node:test";
import assert from "node:assert/strict";
import {
  OAUTH_FLOW_TTL_SECONDS,
  STATE_COOKIE_NAME,
  constantTimeEqual,
  consumeConsentRecord,
  consumeGitHubStateRecord,
  createConsentRecord,
  createGitHubStateRecord,
  readCookie,
  secureCookie,
  sha256Hex,
  validateConsentRequestHeaders,
} from "../src/oauth-security.js";

function createStateNamespace() {
  const objects = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      if (!objects.has(id.name)) {
        let envelope = null;
        objects.set(id.name, {
          async putState(record, expiresAt) {
            envelope = { record, expiresAt };
            return { ok: true };
          },
          async consumeState(expectedHash = "") {
            const current = envelope;
            envelope = null;
            if (!current || Number(current.expiresAt) <= Date.now()) {
              return { ok: false, reason: "expired_or_replayed" };
            }
            if (expectedHash) {
              const storedHash = String(current.record?.csrfHash || "");
              if (!storedHash || !constantTimeEqual(storedHash, expectedHash)) {
                return { ok: false, reason: "mismatch" };
              }
            }
            return { ok: true, record: current.record };
          },
        });
      }
      return objects.get(id.name);
    },
  };
}

const ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";

test("constantTimeEqual accepts equal strings and rejects unequal strings", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abc0"), false);
});

test("same-origin consent POST headers are accepted", () => {
  const request = new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
  });
  assert.deepEqual(validateConsentRequestHeaders(request, ORIGIN), { ok: true, reason: "same_origin" });
});

test("cross-origin consent POST headers are rejected", () => {
  const request = new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.deepEqual(validateConsentRequestHeaders(request, ORIGIN), { ok: false, reason: "cross_origin" });
});

test("secure OAuth cookie is host-only, HttpOnly, Secure and SameSite=Lax", () => {
  const cookie = secureCookie(STATE_COOKIE_NAME, "abc", OAUTH_FLOW_TTL_SECONDS);
  assert.match(cookie, /^__Host-BBC_MCP_STATE=abc;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /SameSite=Lax/);
});

test("readCookie returns the exact requested cookie", () => {
  const request = new Request(`${ORIGIN}/callback`, { headers: { cookie: "a=1; __Host-BBC_MCP_STATE=xyz; b=2" } });
  assert.equal(readCookie(request, STATE_COOKIE_NAME), "xyz");
});

test("consent state is stored in a named Durable Object and consumed once", async () => {
  const namespace = createStateNamespace();
  const oauthRequest = { clientId: "client-1", scope: ["quote.read"] };
  const { consentId, csrfToken } = await createConsentRecord(namespace, oauthRequest, 60);
  const request = new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
  });
  const first = await consumeConsentRecord(namespace, consentId, csrfToken, request, ORIGIN);
  assert.equal(first.ok, true);
  assert.deepEqual(first.oauthRequest, oauthRequest);
  const replay = await consumeConsentRecord(namespace, consentId, csrfToken, request, ORIGIN);
  assert.deepEqual(replay, { ok: false, reason: "expired_or_replayed" });
});

test("wrong consent CSRF value consumes the one-time challenge", async () => {
  const namespace = createStateNamespace();
  const { consentId } = await createConsentRecord(namespace, { clientId: "client-2" }, 60);
  const request = new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
  });
  const mismatch = await consumeConsentRecord(namespace, consentId, "wrong", request, ORIGIN);
  assert.deepEqual(mismatch, { ok: false, reason: "mismatch" });
  const replay = await consumeConsentRecord(namespace, consentId, "wrong", request, ORIGIN);
  assert.deepEqual(replay, { ok: false, reason: "expired_or_replayed" });
});

test("GitHub state is bound to its hash and consumed once", async () => {
  const namespace = createStateNamespace();
  const state = "state-123";
  const oauthRequest = { clientId: "client-3", redirectUri: "https://chatgpt.com/callback" };
  const { stateHash } = await createGitHubStateRecord(namespace, state, oauthRequest, 60);
  assert.equal(stateHash, await sha256Hex(state));
  const first = await consumeGitHubStateRecord(namespace, state, stateHash);
  assert.equal(first.ok, true);
  assert.deepEqual(first.oauthRequest, oauthRequest);
  const replay = await consumeGitHubStateRecord(namespace, state, stateHash);
  assert.deepEqual(replay, { ok: false, reason: "expired_or_replayed" });
});

test("GitHub state rejects a wrong browser-bound hash and remains single-use", async () => {
  const namespace = createStateNamespace();
  const state = "state-456";
  const { stateHash } = await createGitHubStateRecord(namespace, state, { clientId: "client-4" }, 60);
  const mismatch = await consumeGitHubStateRecord(namespace, state, `${stateHash}0`);
  assert.deepEqual(mismatch, { ok: false, reason: "mismatch" });
  const replay = await consumeGitHubStateRecord(namespace, state, stateHash);
  assert.deepEqual(replay, { ok: false, reason: "expired_or_replayed" });
});
