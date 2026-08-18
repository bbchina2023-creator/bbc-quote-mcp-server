import baseWorker from "./staging-contour.js";

const CSRF_COOKIE_PREFIX = "__Host-BBC_MCP_CSRF_";
const STATE_COOKIE_PREFIX = "__Host-BBC_MCP_STATE_";
const COMPAT_CSRF_PREFIX = "bbc:oauth:compat:csrf:";
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractHiddenValue(html, name) {
  const pattern = new RegExp(`<input[^>]+name=["']${name}["'][^>]+value=["']([^"']+)["']`, "i");
  const match = String(html || "").match(pattern);
  return match ? match[1] : "";
}

async function handleAuthorizeGet(request, env, ctx) {
  const response = await baseWorker.fetch(request, env, ctx);
  if (!response.ok) return response;
  const html = await response.clone().text();
  const consentId = extractHiddenValue(html, "consent_id");
  const csrfToken = extractHiddenValue(html, "csrf_token");
  if (consentId && csrfToken) {
    await env.OAUTH_KV.put(
      `${COMPAT_CSRF_PREFIX}${consentId}`,
      JSON.stringify({ csrfToken }),
      { expirationTtl: FLOW_TTL_SECONDS },
    );
  }
  return response;
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

  const compatRaw = await env.OAUTH_KV.get(`${COMPAT_CSRF_PREFIX}${consentId}`);
  let compat = null;
  try { compat = compatRaw ? JSON.parse(compatRaw) : null; } catch { compat = null; }
  if (!compat || compat.csrfToken !== csrfFromForm) {
    return new Response("CSRF validation failed", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const csrfCookieName = `${CSRF_COOKIE_PREFIX}${consentId}`;
  let repairedRequest = request;
  if (readCookie(request, csrfCookieName) !== csrfFromForm) {
    repairedRequest = cloneRequestWithCookie(request, csrfCookieName, csrfFromForm, encodeFormData(formData));
  }

  const response = await baseWorker.fetch(repairedRequest, env, ctx);
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
      }
    }
  }
  await env.OAUTH_KV.delete(`${COMPAT_CSRF_PREFIX}${consentId}`);
  return response;
}

async function handleCallback(request, env, ctx) {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") || "").trim();
  if (!state) return baseWorker.fetch(request, env, ctx);

  const stateCookieName = `${STATE_COOKIE_PREFIX}${state}`;
  const expectedHash = await sha256Hex(state);
  let repairedRequest = request;
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
      reconnectCompatibility: "SERVER_SIDE_CSRF_AND_STATE_V2",
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
    if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env, ctx);
    if (url.pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env, ctx);
    if (url.pathname === "/callback" && request.method === "GET") return handleCallback(request, env, ctx);
    return baseWorker.fetch(request, env, ctx);
  },
};
