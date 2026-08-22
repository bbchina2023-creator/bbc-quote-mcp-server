export const OAUTH_FLOW_TTL_SECONDS = 10 * 60;
export const CONSENT_STATE_PREFIX = "bbc:oauth:consent:";
export const GITHUB_STATE_PREFIX = "bbc:oauth:github-state:";
export const STATE_COOKIE_NAME = "__Host-BBC_MCP_STATE";

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function validateConsentRequestHeaders(request, allowedOrigin) {
  const origin = String(request.headers.get("origin") || "").trim();
  if (origin && origin !== "null" && origin !== allowedOrigin) {
    return { ok: false, reason: "cross_origin" };
  }

  const referer = String(request.headers.get("referer") || "").trim();
  if (referer) {
    let refererOrigin;
    try { refererOrigin = new URL(referer).origin; }
    catch { return { ok: false, reason: "invalid_referer" }; }
    if (refererOrigin !== allowedOrigin) return { ok: false, reason: "cross_origin_referer" };
  }

  const fetchSite = String(request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  // Fetch Metadata is advisory here. OAuth clients can launch consent in a new
  // top-level browsing context where Chromium reports `cross-site`, `same-site`
  // or an opaque (`Origin: null`) initiator. The actual CSRF control is the
  // random, server-stored, one-time synchronizer token consumed below. An
  // explicit foreign Origin/Referer is still rejected above.
  if (origin === allowedOrigin) return { ok: true, reason: "same_origin" };
  if (referer) return { ok: true, reason: "same_origin_referer" };
  if (origin === "null") return { ok: true, reason: `opaque_origin_token:${fetchSite || "unknown"}` };
  return { ok: true, reason: `synchronizer_token:${fetchSite || "unknown"}` };
}

function getOneTimeStateStub(stateNamespace, objectName) {
  if (!stateNamespace || typeof stateNamespace.idFromName !== "function" || typeof stateNamespace.get !== "function") {
    throw new Error("OAUTH_STATE Durable Object binding is not configured");
  }
  return stateNamespace.get(stateNamespace.idFromName(objectName));
}

function expiryFromTtl(ttlSeconds) {
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("OAuth state TTL is invalid");
  return Date.now() + (ttl * 1000);
}

export async function createConsentRecord(stateNamespace, oauthRequest, ttlSeconds = OAUTH_FLOW_TTL_SECONDS) {
  const consentId = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
  const csrfHash = await sha256Hex(csrfToken);
  await getOneTimeStateStub(stateNamespace, `${CONSENT_STATE_PREFIX}${consentId}`).putState(
    { kind: "consent", oauthRequest, csrfHash, createdAt: Date.now() },
    expiryFromTtl(ttlSeconds),
  );
  return { consentId, csrfToken };
}

export async function consumeConsentRecord(stateNamespace, consentId, csrfToken, request, allowedOrigin) {
  if (!consentId || !csrfToken) return { ok: false, reason: "missing" };

  const headerValidation = validateConsentRequestHeaders(request, allowedOrigin);
  if (!headerValidation.ok) return headerValidation;

  const submittedHash = await sha256Hex(csrfToken);
  const consumed = await getOneTimeStateStub(
    stateNamespace,
    `${CONSENT_STATE_PREFIX}${consentId}`,
  ).consumeState(submittedHash);

  if (!consumed?.ok) return { ok: false, reason: consumed?.reason || "expired_or_replayed" };
  const record = consumed.record;
  if (record?.kind !== "consent" || !record.oauthRequest) return { ok: false, reason: "invalid_record" };
  return { ok: true, oauthRequest: record.oauthRequest, validation: headerValidation.reason };
}

export async function createGitHubStateRecord(
  stateNamespace,
  state,
  oauthRequest,
  ttlSeconds = OAUTH_FLOW_TTL_SECONDS,
) {
  if (!state) throw new Error("GitHub OAuth state is required");
  const stateHash = await sha256Hex(state);
  await getOneTimeStateStub(stateNamespace, `${GITHUB_STATE_PREFIX}${state}`).putState(
    { kind: "github", oauthRequest, csrfHash: stateHash, createdAt: Date.now() },
    expiryFromTtl(ttlSeconds),
  );
  return { stateHash };
}

export async function consumeGitHubStateRecord(stateNamespace, state, expectedStateHash) {
  if (!state || !expectedStateHash) return { ok: false, reason: "missing" };
  const consumed = await getOneTimeStateStub(
    stateNamespace,
    `${GITHUB_STATE_PREFIX}${state}`,
  ).consumeState(expectedStateHash);
  if (!consumed?.ok) return { ok: false, reason: consumed?.reason || "expired_or_replayed" };
  const record = consumed.record;
  if (record?.kind !== "github" || !record.oauthRequest) return { ok: false, reason: "invalid_record" };
  return { ok: true, oauthRequest: record.oauthRequest };
}

export function readCookie(request, name) {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const rawCookie of cookieHeader.split(";")) {
    const cookie = rawCookie.trim();
    const separator = cookie.indexOf("=");
    if (separator >= 0 && cookie.slice(0, separator) === name) return cookie.slice(separator + 1);
  }
  return null;
}

export function secureCookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function safeOAuthLog(event, request, details = {}) {
  const url = new URL(request.url);
  console.log(JSON.stringify({
    event,
    method: request.method,
    pathname: url.pathname,
    originPresent: request.headers.has("origin"),
    originMatches: String(request.headers.get("origin") || "") === url.origin,
    secFetchSite: String(request.headers.get("sec-fetch-site") || ""),
    refererPresent: request.headers.has("referer"),
    cookieNames: String(request.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim().split("=", 1)[0])
      .filter(Boolean),
    contentType: String(request.headers.get("content-type") || ""),
    ...details,
  }));
}
