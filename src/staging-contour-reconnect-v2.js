import baseWorker from "./staging-contour.js";

const MCP_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const CSRF_COOKIE_PREFIX = "__Host-BBC_MCP_CSRF_";
const STATE_COOKIE_PREFIX = "__Host-BBC_MCP_STATE_";
const COMPAT_STATE_PREFIX = "bbc:oauth:compat:state:";
const FLOW_TTL_SECONDS = 10 * 60;

function readCookie(request, name) {
  const cookieHeader = String(request.headers.get("cookie") || "");
  for (const rawCookie of cookieHeader.split(";")) {
    const cookie = rawCookie.trim();
    const separator = cookie.indexOf("=");
    if (separator >= 0 && cookie.slice(0, separator) === name) return cookie.slice(separator + 1);
  }
  return null;
}

function upsertCookieHeader(existingHeader, name, value) {
  const kept = String(existingHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith(`${name}=`));
  kept.push(`${name}=${value}`);
  return kept.join("; ");
}

function cloneRequestWithCookie(request, name, value, bodyOverride = null) {
  const headers = new Headers(request.headers);
  headers.set("cookie", upsertCookieHeader(headers.get("cookie"), name, value));
  if (bodyOverride !== null) {
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    headers.delete("content-length");
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bodyOverride,
    redirect: request.redirect,
  });
}

function encodeFormData(formData) {
  const body = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") body.append(key, value);
  }
  return body;
}

function isTrustedSameOriginConsentPost(request) {
  const origin = String(request.headers.get("origin") || "").trim();
  if (origin !== MCP_ORIGIN) return false;

  const fetchSite = String(request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return false;

  return true;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleAuthorizePost(request, env, ctx) {
  let formData;
  try {
    formData = await request.clone().formData();
  } catch {
    return baseWorker.fetch(request, env, ctx);
  }

  const consentId = String(formData.get("consent_id") || "").trim();
  const csrfFromForm = String(formData.get("csrf_token") || "").trim();
  if (!consentId || !csrfFromForm) return baseWorker.fetch(request, env, ctx);

  const csrfCookieName = `${CSRF_COOKIE_PREFIX}${consentId}`;
  const csrfFromCookie = readCookie(request, csrfCookieName);

  // Normal path: the browser preserved the HttpOnly CSRF cookie set by the
  // authorization page. Do not add any compatibility behavior in this case.
  let repairedRequest = request;

  // ChatGPT reconnect can lose the short-lived consent cookie between the
  // authorization GET and same-origin form POST. In that one case, recover the
  // cookie only when the browser proves the POST originated from this exact
  // Worker origin. Referrer is intentionally not required because the base
  // authorization response sets Referrer-Policy: no-referrer.
  if (csrfFromCookie !== csrfFromForm) {
    if (!isTrustedSameOriginConsentPost(request)) {
      return baseWorker.fetch(request, env, ctx);
    }
    repairedRequest = cloneRequestWithCookie(
      request,
      csrfCookieName,
      csrfFromForm,
      encodeFormData(formData),
    );
  }

  const response = await baseWorker.fetch(repairedRequest, env, ctx);

  // Preserve a server-side callback marker as a secondary recovery path if a
  // browser later loses the state-binding cookie on the GitHub round trip.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (location) {
      try {
        const redirectUrl = new URL(location);
        if (redirectUrl.hostname === "github.com" && redirectUrl.pathname === "/login/oauth/authorize") {
          const state = String(redirectUrl.searchParams.get("state") || "").trim();
          if (state) {
            await env.OAUTH_KV.put(
              `${COMPAT_STATE_PREFIX}${state}`,
              JSON.stringify({ createdAt: Date.now() }),
              { expirationTtl: FLOW_TTL_SECONDS },
            );
          }
        }
      } catch {
        // Base response remains authoritative.
      }
    }
  }

  return response;
}

async function handleCallback(request, env, ctx) {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") || "").trim();
  if (!state) return baseWorker.fetch(request, env, ctx);

  const stateCookieName = `${STATE_COOKIE_PREFIX}${state}`;
  const expectedHash = await sha256Hex(state);
  let repairedRequest = request;

  // Prefer the real browser-bound state cookie. Only use the compatibility
  // marker when that cookie is missing and the marker from the successful
  // same-origin consent POST is present.
  if (readCookie(request, stateCookieName) !== expectedHash) {
    const marker = await env.OAUTH_KV.get(`${COMPAT_STATE_PREFIX}${state}`);
    if (marker) repairedRequest = cloneRequestWithCookie(request, stateCookieName, expectedHash);
  }

  const response = await baseWorker.fetch(repairedRequest, env, ctx);
  await env.OAUTH_KV.delete(`${COMPAT_STATE_PREFIX}${state}`);
  return response;
}

async function handleHealth(request, env, ctx) {
  const response = await baseWorker.fetch(request, env, ctx);
  if (!response.ok) return response;
  try {
    const payload = await response.clone().json();
    return Response.json({
      ...payload,
      reconnectCompatibility: "SAME_ORIGIN_CSRF_RECOVERY_V2_1",
      workerEntrypoint: "src/staging-contour-reconnect-v2.js",
    }, { status: response.status, headers: { "cache-control": "no-store" } });
  } catch {
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(request, env, ctx);
    if (url.pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env, ctx);
    if (url.pathname === "/callback" && request.method === "GET") return handleCallback(request, env, ctx);
    return baseWorker.fetch(request, env, ctx);
  },
};
