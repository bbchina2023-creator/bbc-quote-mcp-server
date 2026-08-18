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
  if (origin && origin !== allowedOrigin) return { ok: false, reason: "cross_origin" };

  const fetchSite = String(request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, reason: "cross_site" };
  }
  return { ok: true, reason: origin ? "same_origin" : "synchronizer_token" };
}

export async function createConsentRecord(kv, oauthRequest, ttlSeconds = OAUTH_FLOW_TTL_SECONDS) {
  const consentId = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
  const csrfHash = await sha256Hex(csrfToken);
  await kv.put(
    `${CONSENT_STATE_PREFIX}${consentId}`,
    JSON.stringify({ oauthRequest, csrfHash, createdAt: Date.now() }),
    { expirationTtl: ttlSeconds },
  );
  return { consentId, csrfToken };
}

export async function consumeConsentRecord(kv, consentId, csrfToken, request, allowedOrigin) {
  if (!consentId || !csrfToken) return { ok: false, reason: "missing" };

  const headerValidation = validateConsentRequestHeaders(request, allowedOrigin);
  if (!headerValidation.ok) return headerValidation;

  const key = `${CONSENT_STATE_PREFIX}${consentId}`;
  const serialized = await kv.get(key);
  if (!serialized) return { ok: false, reason: "expired_or_replayed" };

  // A consent challenge is single-use. Consume it before checking the answer so
  // a failed guess cannot be retried against the same authorization request.
  await kv.delete(key);

  let record;
  try {
    record = JSON.parse(serialized);
  } catch {
    return { ok: false, reason: "invalid_record" };
  }

  const submittedHash = await sha256Hex(csrfToken);
  if (!constantTimeEqual(record.csrfHash, submittedHash)) return { ok: false, reason: "mismatch" };
  if (!record.oauthRequest) return { ok: false, reason: "invalid_record" };
  return { ok: true, oauthRequest: record.oauthRequest, validation: headerValidation.reason };
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
