export const ACTION_BRIDGE_VERSION = "ACTIONS-RC-02";
export const ACTION_BODY_MAX_BYTES = 90000;
export const ACTION_RESPONSE_MAX_BYTES = 90000;

export const ACTION_ROUTE_TO_BACKEND = Object.freeze({
  "/actions/validate-canonical-deal": "validateCanonicalDeal",
  "/actions/recalculate-deal": "recalculateDeal",
  "/actions/get-verified-snapshot": "getVerifiedSnapshot",
  "/actions/generate-quote": "generateQuote",
  "/actions/get-deal-status": "getDealStatus",
});

function byteLength(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function responseFromSerialized(serialized, status = 200, extraHeaders = {}) {
  return new Response(serialized, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function actionJson(data, status = 200, extraHeaders = {}) {
  const serialized = JSON.stringify(data);
  if (byteLength(serialized) > ACTION_RESPONSE_MAX_BYTES) {
    return responseFromSerialized(JSON.stringify({
      ok: false,
      error: "ACTION_RESPONSE_TOO_LARGE",
      maxBytes: ACTION_RESPONSE_MAX_BYTES,
    }), 502, extraHeaders);
  }
  return responseFromSerialized(serialized, status, extraHeaders);
}

export function constantTimeSecretEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function requireActionAuthorization(request, env) {
  const expected = String(env.GPT_ACTION_KEY || "").trim();
  if (!expected) {
    return {
      ok: false,
      response: actionJson({ ok: false, error: "GPT_ACTION_KEY_NOT_CONFIGURED" }, 503),
    };
  }

  const header = String(request.headers.get("authorization") || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const supplied = match ? String(match[1] || "").trim() : "";
  if (!constantTimeSecretEqual(supplied, expected)) {
    return {
      ok: false,
      response: actionJson(
        { ok: false, error: "UNAUTHORIZED" },
        401,
        { "www-authenticate": 'Bearer realm="BBC GPT Actions"' },
      ),
    };
  }
  return { ok: true };
}

function requireNonEmptyString(value, fieldName, minLength = 1) {
  const text = String(value || "").trim();
  if (text.length < minLength) throw new Error(`${fieldName} is required.`);
  if (text.length > 300) throw new Error(`${fieldName} is too long.`);
  return text;
}

function requireObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value;
}

function requireCanonicalDealJson(value) {
  if (typeof value !== "string") {
    throw new Error("canonicalDealJson must be a JSON string.");
  }
  const text = value.trim();
  if (!text) throw new Error("canonicalDealJson is required.");
  if (byteLength(text) > ACTION_BODY_MAX_BYTES - 1024) {
    throw new Error("canonicalDealJson is too large.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("canonicalDealJson must contain valid JSON.");
  }
  return requireObject(parsed, "canonicalDealJson JSON value");
}

function requireCanonicalDealTransport(input) {
  const hasObject = Object.prototype.hasOwnProperty.call(input, "canonicalDeal");
  const hasJson = Object.prototype.hasOwnProperty.call(input, "canonicalDealJson");
  if (hasObject === hasJson) {
    throw new Error("Exactly one of canonicalDealJson or canonicalDeal is required.");
  }
  return hasJson
    ? requireCanonicalDealJson(input.canonicalDealJson)
    : requireObject(input.canonicalDeal, "canonicalDeal");
}

function assertOnlyKeys(args, allowed) {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (extra.length) throw new Error(`Unsupported field(s): ${extra.join(", ")}`);
}

export function normalizeActionArguments(action, args) {
  const input = requireObject(args, "request body");

  switch (action) {
    case "validateCanonicalDeal":
      assertOnlyKeys(input, ["canonicalDealJson", "canonicalDeal"]);
      return { canonicalDeal: requireCanonicalDealTransport(input) };

    case "recalculateDeal":
      assertOnlyKeys(input, ["validatedCanonicalRef", "idempotencyKey"]);
      return {
        validatedCanonicalRef: requireNonEmptyString(input.validatedCanonicalRef, "validatedCanonicalRef", 20),
        idempotencyKey: requireNonEmptyString(input.idempotencyKey, "idempotencyKey", 8),
      };

    case "getVerifiedSnapshot": {
      assertOnlyKeys(input, ["snapshotId", "dealId"]);
      const snapshotId = String(input.snapshotId || "").trim();
      const dealId = String(input.dealId || "").trim();
      if ((!snapshotId && !dealId) || (snapshotId && dealId)) {
        throw new Error("Exactly one of snapshotId or dealId is required.");
      }
      return snapshotId
        ? { snapshotId: requireNonEmptyString(snapshotId, "snapshotId"), includePayload: false }
        : { dealId: requireNonEmptyString(dealId, "dealId"), includePayload: false };
    }

    case "generateQuote": {
      assertOnlyKeys(input, ["snapshotId", "idempotencyKey", "outputProfile"]);
      const outputProfile = String(input.outputProfile || "FULL_MASTER_WORKBOOK").trim();
      if (outputProfile !== "FULL_MASTER_WORKBOOK") {
        throw new Error(`Unsupported outputProfile: ${outputProfile}`);
      }
      return {
        snapshotId: requireNonEmptyString(input.snapshotId, "snapshotId"),
        idempotencyKey: requireNonEmptyString(input.idempotencyKey, "idempotencyKey", 8),
        outputProfile,
      };
    }

    case "getDealStatus":
      assertOnlyKeys(input, ["dealId"]);
      return { dealId: requireNonEmptyString(input.dealId, "dealId") };

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

function safeErrorMessage(error) {
  const text = String(error instanceof Error ? error.message : error || "UNKNOWN_ERROR");
  return text.slice(0, 2000);
}

export function createActionBridgeHandler(callBackend) {
  if (typeof callBackend !== "function") throw new Error("callBackend function is required");

  return async function handleActionRequest(request, env, action) {
    if (!Object.values(ACTION_ROUTE_TO_BACKEND).includes(action)) {
      return actionJson({ ok: false, error: "ACTION_NOT_FOUND" }, 404);
    }

    if (request.method !== "POST") {
      return actionJson(
        { ok: false, error: "METHOD_NOT_ALLOWED" },
        405,
        { allow: "POST" },
      );
    }

    const auth = requireActionAuthorization(request, env);
    if (!auth.ok) return auth.response;

    const contentType = String(request.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return actionJson({ ok: false, error: "APPLICATION_JSON_REQUIRED" }, 415);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > ACTION_BODY_MAX_BYTES) {
      return actionJson({
        ok: false,
        error: "ACTION_PAYLOAD_TOO_LARGE",
        maxBytes: ACTION_BODY_MAX_BYTES,
      }, 413);
    }

    let bodyText = "";
    let args;
    try {
      bodyText = await request.text();
      if (byteLength(bodyText) > ACTION_BODY_MAX_BYTES) {
        return actionJson({
          ok: false,
          error: "ACTION_PAYLOAD_TOO_LARGE",
          maxBytes: ACTION_BODY_MAX_BYTES,
        }, 413);
      }
      args = bodyText.trim() ? JSON.parse(bodyText) : {};
      args = normalizeActionArguments(action, args);
    } catch (error) {
      return actionJson({ ok: false, error: safeErrorMessage(error) }, 400);
    }

    const startedAt = Date.now();
    try {
      const result = await callBackend(env, action, args);
      const durationMs = Date.now() - startedAt;
      return actionJson({
        ok: true,
        action,
        actionBridgeVersion: ACTION_BRIDGE_VERSION,
        durationMs,
        result,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      return actionJson({
        ok: false,
        action,
        actionBridgeVersion: ACTION_BRIDGE_VERSION,
        durationMs,
        error: safeErrorMessage(error),
      }, 502);
    }
  };
}
