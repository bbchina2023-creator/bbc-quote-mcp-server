import baseWorker from "./staging-contour.js";

const MCP_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const CSRF_COOKIE_PREFIX = "__Host-BBC_MCP_CSRF_";

function isSameOriginAuthorizePost(request, url) {
  if (request.method !== "POST" || url.pathname !== "/authorize") return false;
  const origin = String(request.headers.get("origin") || "");
  const referer = String(request.headers.get("referer") || "");
  return origin === MCP_ORIGIN && referer.startsWith(`${MCP_ORIGIN}/authorize`);
}

function cookieHeaderHasName(cookieHeader, name) {
  return String(cookieHeader || "")
    .split(";")
    .some((part) => part.trim().startsWith(`${name}=`));
}

async function repairMissingConsentCookie(request) {
  const url = new URL(request.url);
  if (!isSameOriginAuthorizePost(request, url)) return request;

  const formData = await request.clone().formData();
  const consentId = String(formData.get("consent_id") || "").trim();
  const csrfToken = String(formData.get("csrf_token") || "").trim();
  if (!consentId || !csrfToken) return request;

  const csrfCookieName = `${CSRF_COOKIE_PREFIX}${consentId}`;
  const existingCookie = String(request.headers.get("cookie") || "");
  if (cookieHeaderHasName(existingCookie, csrfCookieName)) return request;

  const headers = new Headers(request.headers);
  const syntheticCookie = `${csrfCookieName}=${csrfToken}`;
  headers.set("cookie", existingCookie ? `${existingCookie}; ${syntheticCookie}` : syntheticCookie);

  const body = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") body.append(key, value);
  }
  headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  headers.delete("content-length");

  return new Request(request.url, {
    method: "POST",
    headers,
    body,
    redirect: request.redirect,
  });
}

export default {
  async fetch(request, env, ctx) {
    const repairedRequest = await repairMissingConsentCookie(request);
    return baseWorker.fetch(repairedRequest, env, ctx);
  },
};
