import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { canonicalDealSchema } from "./canonical-schema.js";
import {
  OAUTH_FLOW_TTL_SECONDS,
  STATE_COOKIE_NAME,
  constantTimeEqual,
  consumeConsentRecord,
  consumeGitHubStateRecord,
  createConsentRecord,
  createGitHubStateRecord,
  readCookie,
  safeOAuthLog,
  secureCookie,
  sha256Hex,
} from "./oauth-security.js";

export { OAuthStateDurableObject } from "./oauth-state-do.js";

const SERVER_NAME = "BBC KP Generator — Document Contour";
const SERVER_VERSION = "1.0.0-contour-v1-staging";
const RELEASE_ID = "RC-CORR-01C";
const CANONICAL_SCHEMA_ID = "canonical-deal-contract-v1";
const MCP_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const GITHUB_CALLBACK = `${MCP_ORIGIN}/callback`;
const ALLOWED_GITHUB_USER_ID = 307006935;
export const RESOURCE_SCOPES = ["quote.read", "quote.write", "quote.generate"];
export const SUPPORTED_SCOPES = [...RESOURCE_SCOPES, "offline_access"];
export const TOOL_CONTRACT = [
  "validateCanonicalDeal",
  "recalculateDeal",
  "getVerifiedSnapshot",
  "generateQuote",
  "getDealStatus",
];

const TOOL_SCOPES = Object.freeze({
  validateCanonicalDeal: "quote.read",
  recalculateDeal: "quote.write",
  getVerifiedSnapshot: "quote.read",
  generateQuote: "quote.generate",
  getDealStatus: "quote.read",
});

async function decodeAppsScriptResponse(initialResponse) {
  let response = initialResponse;
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(response.status) && hops < 5) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Apps Script redirect ${response.status} without Location header`);
    response = await fetch(location, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    hops += 1;
  }
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Apps Script HTTP ${response.status}: ${responseText.slice(0, 1500)}`);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`Apps Script returned non-JSON payload: ${responseText.slice(0, 1500)}`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error(String(payload?.error || payload?.message || "Apps Script backend returned ok=false"));
  }
  return payload.result;
}

async function callBackend(env, action, args) {
  const backendUrl = String(env.BBC_BACKEND_URL || "").trim();
  const backendToken = String(env.BBC_BACKEND_TOKEN || "").trim();
  if (!backendUrl) throw new Error("BBC_BACKEND_URL secret is not configured");
  if (!backendToken) throw new Error("BBC_BACKEND_TOKEN secret is not configured");
  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action, arguments: args, backendToken }),
    redirect: "manual",
  });
  return decodeAppsScriptResponse(response);
}

function successResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2),
    }],
  };
}

function enforceToolScope(extra, toolName) {
  const requiredScope = TOOL_SCOPES[toolName];
  const scopes = Array.isArray(extra?.authInfo?.scopes) ? extra.authInfo.scopes : [];
  if (requiredScope && scopes.includes(requiredScope)) return null;
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: "insufficient_scope",
        tool: toolName,
        requiredScope,
      }, null, 2),
    }],
  };
}

function createServer(env) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "validateCanonicalDeal",
    {
      title: "Проверить Canonical Deal",
      description:
        "Read-only validation of Canonical Deal Contract v1 assembled by ChatGPT from the current uploaded documents. " +
        "Checks schema, lineage, rule authority, payment schedule, quote readiness and deterministic preview. " +
        "The backend does not semantically parse source documents.",
      inputSchema: { canonicalDeal: canonicalDealSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      const denied = enforceToolScope(extra, "validateCanonicalDeal");
      if (denied) return denied;
      try { return successResult(await callBackend(env, "validateCanonicalDeal", args)); }
      catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "recalculateDeal",
    {
      title: "Создать verified Snapshot v2",
      description:
        "Deterministically calculates an already prepared Canonical Deal Contract v1, persists immutable canonical/payment/rule records, " +
        "and creates VERIFIED Snapshot v2. Requires a stable idempotency key. No raw-import reads and no legacy calculation writes.",
      inputSchema: {
        canonicalDeal: canonicalDealSchema,
        idempotencyKey: z.string().min(8),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      const denied = enforceToolScope(extra, "recalculateDeal");
      if (denied) return denied;
      try { return successResult(await callBackend(env, "recalculateDeal", args)); }
      catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "getVerifiedSnapshot",
    {
      title: "Получить verified Snapshot v2",
      description: "Returns a verified Snapshot v2 by snapshotId or the latest verified Snapshot v2 for a dealId.",
      inputSchema: {
        snapshotId: z.string().min(1).optional(),
        dealId: z.string().min(1).optional(),
        includePayload: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      const denied = enforceToolScope(extra, "getVerifiedSnapshot");
      if (denied) return denied;
      try {
        if (!args.snapshotId && !args.dealId) throw new Error("snapshotId or dealId is required");
        return successResult(await callBackend(env, "getVerifiedSnapshot", args));
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "generateQuote",
    {
      title: "Сформировать КП из Snapshot v2",
      description:
        "Generates the approved 5-sheet Google Sheets workbook, XLSX and client PDF strictly from an immutable VERIFIED Snapshot v2. " +
        "Does not recalculate or reread source imports. Safe to retry with the same idempotency key.",
      inputSchema: {
        snapshotId: z.string().min(1),
        idempotencyKey: z.string().min(8),
        outputProfile: z.enum(["FULL_MASTER_WORKBOOK"]).optional().default("FULL_MASTER_WORKBOOK"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      const denied = enforceToolScope(extra, "generateQuote");
      if (denied) return denied;
      try { return successResult(await callBackend(env, "generateQuote", args)); }
      catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "getDealStatus",
    {
      title: "Получить статус сделки",
      description: "Returns the latest verified Snapshot v2 and quote artifacts bound to that exact latest snapshot for the specified dealId.",
      inputSchema: { dealId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      const denied = enforceToolScope(extra, "getDealStatus");
      if (denied) return denied;
      try { return successResult(await callBackend(env, "getDealStatus", args)); }
      catch (error) { return errorResult(error); }
    },
  );

  return server;
}

function requireOAuthConfiguration(env) {
  if (!String(env.GITHUB_CLIENT_ID || "").trim()) throw new Error("GITHUB_CLIENT_ID is not configured");
  if (!String(env.GITHUB_CLIENT_SECRET || "").trim()) throw new Error("GITHUB_CLIENT_SECRET secret is not configured");
  if (!env.OAUTH_STATE) throw new Error("OAUTH_STATE Durable Object binding is not configured");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function textResponse(body, status, setCookies = []) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
}

function htmlResponse(body, setCookies = []) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(body, { status: 200, headers });
}

async function showAuthorizationConsent(request, env) {
  requireOAuthConfiguration(env);
  let oauthRequest;
  try { oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
  catch { return textResponse("Invalid authorization request", 400); }
  const clientId = String(oauthRequest.clientId || "").trim();
  if (!clientId) return textResponse("Missing OAuth client ID", 400);
  let client;
  try { client = await env.OAUTH_PROVIDER.lookupClient(clientId); }
  catch { return textResponse("Unknown OAuth client", 400); }
  const { consentId, csrfToken } = await createConsentRecord(env.OAUTH_STATE, oauthRequest);
  const scopes = Array.isArray(oauthRequest.scope) ? oauthRequest.scope : [];
  const clientName = String(client?.clientName || client?.client_name || client?.name || clientId).trim();
  safeOAuthLog("oauth.authorize.get.ready", request, { consentStored: true, stateStorage: "durable_object" });
  return htmlResponse(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BBC КП — доступ</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#1f2937}main{max-width:680px;margin:8vh auto;background:#fff;padding:32px;border-radius:16px}button{padding:11px 18px;border:0;border-radius:9px;margin-right:10px}.ok{background:#111827;color:#fff}</style></head><body><main><h1>Разрешить доступ к BBC KP Generator?</h1><p>Клиент: <strong>${escapeHtml(clientName)}</strong></p><p>Права: ${escapeHtml(scopes.join(", ") || "нет")}</p><form method="post" action="/authorize"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="consent_id" value="${escapeHtml(consentId)}"><button class="ok" name="decision" value="approve">Разрешить</button><button name="decision" value="deny">Отменить</button></form></main></body></html>`);
}

async function handleAuthorizationConsent(request, env) {
  requireOAuthConfiguration(env);
  let formData;
  try { formData = await request.formData(); }
  catch { return textResponse("Invalid consent form", 400); }
  const consentId = String(formData.get("consent_id") || "").trim();
  if (!consentId) return textResponse("Missing consent state", 400);
  const csrfFromForm = String(formData.get("csrf_token") || "");
  const consent = await consumeConsentRecord(env.OAUTH_STATE, consentId, csrfFromForm, request, MCP_ORIGIN);
  safeOAuthLog("oauth.authorize.post.validated", request, {
    consentIdPresent: Boolean(consentId),
    csrfTokenPresent: Boolean(csrfFromForm),
    validationResult: consent.ok ? "accepted" : consent.reason,
    stateStorage: "durable_object",
  });
  if (!consent.ok) return textResponse("CSRF validation failed", 400);
  if (String(formData.get("decision") || "") !== "approve") return textResponse("Authorization cancelled", 403);
  const oauthRequest = consent.oauthRequest;
  const state = crypto.randomUUID();
  const { stateHash } = await createGitHubStateRecord(env.OAUTH_STATE, state, oauthRequest);
  const stateCookie = secureCookie(STATE_COOKIE_NAME, stateHash, OAUTH_FLOW_TTL_SECONDS);
  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", GITHUB_CALLBACK);
  githubUrl.searchParams.set("scope", "read:user user:email");
  githubUrl.searchParams.set("state", state);
  const headers = new Headers({ location: githubUrl.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  headers.append("set-cookie", stateCookie);
  return new Response(null, { status: 302, headers });
}

async function exchangeGitHubCode(code, env) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "BBC-KP-Generator-MCP" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_CALLBACK }),
  });
  if (!response.ok) throw new Error(`GitHub token exchange failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error(payload.error_description || payload.error || "GitHub access token missing");
  return payload.access_token;
}

async function fetchGitHubUser(accessToken) {
  const response = await fetch("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "BBC-KP-Generator-MCP", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
  return response.json();
}

async function finishGitHubAuthorization(request, env) {
  requireOAuthConfiguration(env);
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") || "").trim();
  if (!state) return textResponse("Missing GitHub OAuth state", 400);
  const expectedStateHash = await sha256Hex(state);
  const stateHashFromCookie = readCookie(request, STATE_COOKIE_NAME);
  const clearStateCookie = secureCookie(STATE_COOKIE_NAME, "", 0);
  if (!stateHashFromCookie || !constantTimeEqual(stateHashFromCookie, expectedStateHash)) {
    return textResponse("OAuth state is not bound to this browser session", 400, [clearStateCookie]);
  }
  const stored = await consumeGitHubStateRecord(env.OAUTH_STATE, state, expectedStateHash);
  if (!stored.ok) return textResponse("Expired, invalid, or replayed GitHub OAuth state", 400, [clearStateCookie]);
  const oauthRequest = stored.oauthRequest;
  const githubError = url.searchParams.get("error");
  if (githubError) return textResponse(`GitHub authorization failed: ${githubError}`, 403, [clearStateCookie]);
  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) return textResponse("Missing GitHub OAuth code", 400, [clearStateCookie]);
  try {
    const githubAccessToken = await exchangeGitHubCode(code, env);
    const user = await fetchGitHubUser(githubAccessToken);
    if (user.id !== ALLOWED_GITHUB_USER_ID) return textResponse("This GitHub account is not authorized for BBC KP Generator", 403, [clearStateCookie]);
    const requestedScopes = Array.isArray(oauthRequest.scope) ? oauthRequest.scope : [];
    const grantedScopes = requestedScopes.filter((scope) => SUPPORTED_SCOPES.includes(scope));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: String(user.id),
      metadata: { identityProvider: "github", githubLogin: user.login },
      scope: grantedScopes,
      props: { githubUserId: user.id, githubLogin: user.login },
    });
    const headers = new Headers({ location: redirectTo, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    headers.append("set-cookie", clearStateCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return textResponse(error instanceof Error ? error.message : String(error), 500, [clearStateCookie]);
  }
}

const mcpApiHandler = {
  async fetch(request, env, ctx) {
    return createMcpHandler(createServer(env))(request, env, ctx);
  },
};

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const versionMeta = env.CF_VERSION_METADATA || null;
      return Response.json({
        ok: true,
        service: SERVER_NAME,
        version: SERVER_VERSION,
        releaseId: RELEASE_ID,
        contourVersion: "1.0.3",
        canonicalSchema: CANONICAL_SCHEMA_ID,
        oauthSecurity: "DURABLE_OBJECT_ONE_TIME_STATE_V1",
        oneTimeStateStorage: "OAUTH_STATE_DURABLE_OBJECT",
        oauthProviderStorage: "OAUTH_KV",
        workerEntrypoint: "src/staging-contour-rc.js",
        environment: "staging",
        origin: MCP_ORIGIN,
        backendConfigured: Boolean(String(env.BBC_BACKEND_URL || "").trim()),
        backendTokenConfigured: Boolean(String(env.BBC_BACKEND_TOKEN || "").trim()),
        oauthConfigured: Boolean(String(env.GITHUB_CLIENT_ID || "").trim() && String(env.GITHUB_CLIENT_SECRET || "").trim() && env.OAUTH_STATE),
        oauthProvider: "github",
        scopeEnforcement: "SDK_V1_EXTRA_AUTHINFO_PER_TOOL_V1",
        workerVersion: versionMeta ? {
          id: versionMeta.id || null,
          tag: versionMeta.tag || null,
          timestamp: versionMeta.timestamp || null,
        } : null,
        toolContract: TOOL_CONTRACT,
      });
    }
    if (url.pathname === "/authorize") {
      if (request.method === "GET") return showAuthorizationConsent(request, env);
      if (request.method === "POST") return handleAuthorizationConsent(request, env);
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }
    if (url.pathname === "/callback" && request.method === "GET") return finishGitHubAuthorization(request, env);
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: SUPPORTED_SCOPES,
  refreshTokenTTL: 2592000,
  allowPlainPKCE: false,
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ORIGIN],
    scopes_supported: RESOURCE_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: SERVER_NAME,
  },
});