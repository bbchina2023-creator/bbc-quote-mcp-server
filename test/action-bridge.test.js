import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_BODY_MAX_BYTES,
  ACTION_BRIDGE_VERSION,
  ACTION_RESPONSE_MAX_BYTES,
  ACTION_ROUTE_TO_BACKEND,
  createActionBridgeHandler,
  normalizeActionArguments,
} from "../src/action-bridge.js";

const env = { GPT_ACTION_KEY: "test-action-key-123" };
const authHeaders = {
  "content-type": "application/json",
  authorization: "Bearer test-action-key-123",
};

function request(path, body, headers = authHeaders, method = "POST") {
  return new Request(`https://example.test${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

test("bridge exposes exactly five final operations and bounded payloads", () => {
  assert.equal(ACTION_BRIDGE_VERSION, "ACTIONS-RC-02");
  assert.equal(ACTION_BODY_MAX_BYTES, 90000);
  assert.equal(ACTION_RESPONSE_MAX_BYTES, 90000);
  assert.deepEqual(Object.values(ACTION_ROUTE_TO_BACKEND).sort(), [
    "validateCanonicalDeal",
    "recalculateDeal",
    "getVerifiedSnapshot",
    "generateQuote",
    "getDealStatus",
  ].sort());
});

test("missing bearer key is rejected before backend", async () => {
  let called = false;
  const handler = createActionBridgeHandler(async () => { called = true; });
  const res = await handler(request(
    "/actions/get-deal-status",
    { dealId: "BBC-X" },
    { "content-type": "application/json" },
  ), env, "getDealStatus");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /^Bearer/);
  assert.equal(called, false);
});

test("non-JSON body is rejected before backend", async () => {
  let called = false;
  const handler = createActionBridgeHandler(async () => { called = true; });
  const res = await handler(new Request("https://example.test/actions/get-deal-status", {
    method: "POST",
    headers: { authorization: "Bearer test-action-key-123", "content-type": "text/plain" },
    body: "{}",
  }), env, "getDealStatus");
  assert.equal(res.status, 415);
  assert.equal(called, false);
});

test("authorized request passes exact action and normalized arguments", async () => {
  let seen;
  const handler = createActionBridgeHandler(async (_env, action, args) => {
    seen = { action, args };
    return { contourVersion: "1.0.5-rc-corr-03", status: "OK" };
  });
  const res = await handler(request("/actions/get-deal-status", { dealId: "BBC-X" }), env, "getDealStatus");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.action, "getDealStatus");
  assert.equal(body.actionBridgeVersion, "ACTIONS-RC-02");
  assert.equal(Number.isInteger(body.durationMs), true);
  assert.deepEqual(seen, { action: "getDealStatus", args: { dealId: "BBC-X" } });
});



test("canonicalDealJson transport parses into the exact backend object", () => {
  const canonical = { contractVersion: "1.0", dealId: "BBC-X", items: [] };
  assert.deepEqual(
    normalizeActionArguments("validateCanonicalDeal", { canonicalDealJson: JSON.stringify(canonical) }),
    { canonicalDeal: canonical },
  );
  assert.deepEqual(
    normalizeActionArguments("recalculateDeal", {
      canonicalDealJson: JSON.stringify(canonical),
      idempotencyKey: "idempotency-1",
    }),
    { canonicalDeal: canonical, idempotencyKey: "idempotency-1" },
  );
});

test("canonical transport is fail-closed and keeps object compatibility", () => {
  const canonical = { dealId: "BBC-X" };
  assert.deepEqual(
    normalizeActionArguments("validateCanonicalDeal", { canonicalDeal: canonical }),
    { canonicalDeal: canonical },
  );
  assert.throws(
    () => normalizeActionArguments("validateCanonicalDeal", { canonicalDealJson: "not-json" }),
    /valid JSON/,
  );
  assert.throws(
    () => normalizeActionArguments("validateCanonicalDeal", { canonicalDealJson: "[]" }),
    /must be an object/,
  );
  assert.throws(
    () => normalizeActionArguments("validateCanonicalDeal", { canonicalDeal: canonical, canonicalDealJson: "{}" }),
    /Exactly one/,
  );
});

test("getVerifiedSnapshot never exposes full payload through Actions", () => {
  assert.deepEqual(normalizeActionArguments("getVerifiedSnapshot", { dealId: "BBC-X" }), {
    dealId: "BBC-X",
    includePayload: false,
  });
  assert.throws(
    () => normalizeActionArguments("getVerifiedSnapshot", { dealId: "BBC-X", includePayload: true }),
    /Unsupported field/,
  );
});

test("recalculate and generate require stable idempotency keys", () => {
  assert.throws(
    () => normalizeActionArguments("recalculateDeal", { canonicalDeal: {}, idempotencyKey: "short" }),
    /idempotencyKey is required/,
  );
  assert.throws(
    () => normalizeActionArguments("generateQuote", { snapshotId: "S", idempotencyKey: "short" }),
    /idempotencyKey is required/,
  );
});

test("generateQuote is locked to FULL_MASTER_WORKBOOK", () => {
  assert.throws(
    () => normalizeActionArguments("generateQuote", {
      snapshotId: "SNP-X",
      idempotencyKey: "idempotency-1",
      outputProfile: "OTHER",
    }),
    /Unsupported outputProfile/,
  );
});

test("payload safety ceiling fails closed before backend", async () => {
  let called = false;
  const handler = createActionBridgeHandler(async () => { called = true; });
  const huge = { canonicalDeal: { data: "x".repeat(91000) } };
  const res = await handler(request("/actions/validate-canonical-deal", huge), env, "validateCanonicalDeal");
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "ACTION_PAYLOAD_TOO_LARGE");
  assert.equal(called, false);
});

test("response safety ceiling fails closed", async () => {
  const handler = createActionBridgeHandler(async () => ({ data: "x".repeat(91000) }));
  const res = await handler(request("/actions/get-deal-status", { dealId: "BBC-X" }), env, "getDealStatus");
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "ACTION_RESPONSE_TOO_LARGE");
});

test("unsupported fields are rejected before backend", async () => {
  let called = false;
  const handler = createActionBridgeHandler(async () => { called = true; });
  const res = await handler(request("/actions/get-deal-status", { dealId: "BBC-X", unexpected: true }), env, "getDealStatus");
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test("backend error is bounded and never reflects action key", async () => {
  const handler = createActionBridgeHandler(async () => {
    throw new Error("BACKEND_TEST_FAILURE:" + "x".repeat(5000));
  });
  const res = await handler(request("/actions/get-deal-status", { dealId: "BBC-X" }), env, "getDealStatus");
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.match(text, /BACKEND_TEST_FAILURE/);
  assert.equal(text.includes("test-action-key-123"), false);
  assert.equal(text.length < 3000, true);
});
