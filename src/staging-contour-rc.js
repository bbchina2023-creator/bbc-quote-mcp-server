import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { canonicalDealSchema } from "./canonical-schema.js";
import {
  ACTION_BODY_MAX_BYTES,
  ACTION_BRIDGE_VERSION,
  ACTION_RESPONSE_MAX_BYTES,
  ACTION_ROUTE_TO_BACKEND,
  createActionBridgeHandler,
} from "./action-bridge.js";
import {
  OAUTH_FLOW_TTL_SECONDS,
  STATE_COOKIE_NAME,
  constantTimeEqual,
  consumeGitHubStateRecord,
  createGitHubStateRecord,
  readCookie,
  safeOAuthLog,
  secureCookie,
  sha256Hex,
} from "./oauth-security.js";

export { OAuthStateDurableObject } from "./oauth-state-do.js";

const SERVER_NAME = "BBC KP Generator — Document Contour";
const SERVER_VERSION = "1.0.5-rc-corr-06c-staging";
const RELEASE_ID = "RC-CORR-06C";
const EXPECTED_BACKEND_CONTOUR_VERSION = "1.0.7-rc-corr-24";
const SOURCE_BASE_COMMIT = "0e4b1851871c8c3dcd4c11765468f7a3f96f91e1";
const CANONICAL_SCHEMA_ID = "canonical-deal-contract-v1";
const SCOPE_ENFORCEMENT = "ROOT_SECURITY_SCHEMES_INBAND_MCP_AUTH_CHALLENGE_V4";
const BACKEND_TOKEN_MODE = "JSON_BODY_SECRET";
const MCP_AUTH_MODE = "PUBLIC_DISCOVERY_ROOT_SECURITY_SCHEMES_INBAND_OAUTH_V3";
const ACTION_AUTH_MODE = "BEARER_API_KEY";
const MCP_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const MCP_RESOURCE_METADATA = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
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
export const TOOL_REQUIRED_SCOPES = Object.freeze({
  validateCanonicalDeal: "quote.read",
  recalculateDeal: "quote.write",
  getVerifiedSnapshot: "quote.read",
  generateQuote: "quote.generate",
  getDealStatus: "quote.read",
});

function requireBackendConfiguration(env) {
  const backendUrl = String(env.BBC_BACKEND_URL || "").trim();
  const backendToken = String(env.BBC_BACKEND_TOKEN || "").trim();
  if (!backendUrl) throw new Error("BBC_BACKEND_URL secret is not configured");
  if (!backendToken) throw new Error("BBC_BACKEND_TOKEN secret is not configured");
  const url = new URL(backendUrl);
  if (url.searchParams.has("token")) {
    throw new Error("BBC_BACKEND_URL must not contain a token query parameter");
  }
  return { backendUrl, backendToken };
}

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
  const { backendUrl, backendToken } = requireBackendConfiguration(env);
  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action, arguments: args, backendToken }),
    redirect: "manual",
  });
  const result = await decodeAppsScriptResponse(response);
  if (!result || result.contourVersion !== EXPECTED_BACKEND_CONTOUR_VERSION) {
    throw new Error(`BACKEND_CONTOUR_VERSION_MISMATCH: expected ${EXPECTED_BACKEND_CONTOUR_VERSION}, received ${String(result?.contourVersion || "missing")}`);
  }
  return result;
}

const handleActionRequest = createActionBridgeHandler(callBackend);

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

function hasToolScope(effectiveScopes, requiredScope) {
  const granted = Array.isArray(effectiveScopes) ? effectiveScopes : [];
  return granted.includes(requiredScope);
}

function oauthToolChallenge(requiredScope) {
  const challenge =
    `Bearer realm="OAuth", resource_metadata="${MCP_RESOURCE_METADATA}", scope="${requiredScope}", ` +
    `error="insufficient_scope", error_description="OAuth scope ${requiredScope} is required"`;
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Authentication required. OAuth scope ${requiredScope} is required.`,
    }],
    _meta: {
      "mcp/www_authenticate": [challenge],
    },
  };
}

function oauthToolMeta(requiredScope) {
  return {
    securitySchemes: [{ type: "oauth2", scopes: [requiredScope] }],
  };
}

function createServer(env, effectiveScopes) {
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: oauthToolMeta("quote.read"),
    },
    async (args) => {
      try {
        if (!hasToolScope(effectiveScopes, "quote.read")) return oauthToolChallenge("quote.read");
        return successResult(await callBackend(env, "validateCanonicalDeal", args));
      } catch (error) { return errorResult(error); }
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: oauthToolMeta("quote.write"),
    },
    async (args) => {
      try {
        if (!hasToolScope(effectiveScopes, "quote.write")) return oauthToolChallenge("quote.write");
        return successResult(await callBackend(env, "recalculateDeal", args));
      } catch (error) { return errorResult(error); }
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: oauthToolMeta("quote.read"),
    },
    async (args) => {
      try {
        if (!hasToolScope(effectiveScopes, "quote.read")) return oauthToolChallenge("quote.read");
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: oauthToolMeta("quote.generate"),
    },
    async (args) => {
      try {
        if (!hasToolScope(effectiveScopes, "quote.generate")) return oauthToolChallenge("quote.generate");
        return successResult(await callBackend(env, "generateQuote", args));
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "getDealStatus",
    {
      title: "Получить статус сделки",
      description: "Returns the latest verified Snapshot v2 and quote artifacts bound to that exact latest snapshot for the specified dealId.",
      inputSchema: { dealId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: oauthToolMeta("quote.read"),
    },
    async (args) => {
      try {
        if (!hasToolScope(effectiveScopes, "quote.read")) return oauthToolChallenge("quote.read");
        return successResult(await callBackend(env, "getDealStatus", args));
      } catch (error) { return errorResult(error); }
    },
  );

  return server;
}

function requireOAuthConfiguration(env) {
  if (!String(env.GITHUB_CLIENT_ID || "").trim()) throw new Error("GITHUB_CLIENT_ID is not configured");
  if (!String(env.GITHUB_CLIENT_SECRET || "").trim()) throw new Error("GITHUB_CLIENT_SECRET secret is not configured");
  if (!env.OAUTH_STATE) throw new Error("OAUTH_STATE Durable Object binding is not configured");
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

async function beginGitHubAuthorization(request, env) {
  requireOAuthConfiguration(env);
  let oauthRequest;
  try { oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
  catch { return textResponse("Invalid authorization request", 400); }
  const clientId = String(oauthRequest.clientId || "").trim();
  if (!clientId) return textResponse("Missing OAuth client ID", 400);
  let client;
  try { client = await env.OAUTH_PROVIDER.lookupClient(clientId); }
  catch { return textResponse("Unknown OAuth client", 400); }
  if (!client) return textResponse("Unknown OAuth client", 400);
  const state = crypto.randomUUID();
  const { stateHash } = await createGitHubStateRecord(env.OAUTH_STATE, state, oauthRequest);
  const stateCookie = secureCookie(STATE_COOKIE_NAME, stateHash, OAUTH_FLOW_TTL_SECONDS);
  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", GITHUB_CALLBACK);
  githubUrl.searchParams.set("scope", "read:user user:email");
  githubUrl.searchParams.set("state", state);
  safeOAuthLog("oauth.authorize.redirect.github", request, {
    oauthRequestStored: true,
    stateStorage: "durable_object",
  });
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

function oauthChallengeResponse() {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": `Bearer realm="OAuth", resource_metadata="${MCP_RESOURCE_METADATA}"`,
    "access-control-expose-headers": "WWW-Authenticate",
  });
  return new Response("Unauthorized", { status: 401, headers });
}

function tokenAudienceMatches(tokenSummary) {
  const audience = tokenSummary?.audience;
  if (typeof audience === "string") return audience === MCP_RESOURCE;
  if (Array.isArray(audience)) return audience.includes(MCP_RESOURCE);
  return false;
}

async function resolveMcpScopes(request, env) {
  const authorization = String(request.headers.get("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return { scopes: [], tokenState: "missing" };
  const tokenSummary = await env.OAUTH_PROVIDER.unwrapToken(match[1]);
  if (!tokenSummary || !Array.isArray(tokenSummary.scope) || !tokenAudienceMatches(tokenSummary)) {
    return { scopes: [], tokenState: "invalid" };
  }
  return { scopes: tokenSummary.scope, tokenState: "valid" };
}

function promoteRootSecuritySchemesInPayload(payload) {
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) return payload;
  for (const tool of tools) {
    const requiredScope = TOOL_REQUIRED_SCOPES[String(tool?.name || "")];
    if (!requiredScope) continue;
    const schemes = [{ type: "oauth2", scopes: [requiredScope] }];
    tool.securitySchemes = schemes;
    tool._meta = { ...(tool._meta || {}), securitySchemes: schemes };
  }
  return payload;
}

function promoteRootSecuritySchemesInBody(body, contentType) {
  if (!String(body || "").trim()) return body;
  if (String(contentType || "").includes("text/event-stream")) {
    return String(body).split(/(\r?\n)/).map((part) => {
      if (!part.startsWith("data:")) return part;
      const raw = part.slice(5).trim();
      if (!raw.startsWith("{")) return part;
      try {
        const payload = promoteRootSecuritySchemesInPayload(JSON.parse(raw));
        return `data: ${JSON.stringify(payload)}`;
      } catch {
        return part;
      }
    }).join("");
  }
  try {
    return JSON.stringify(promoteRootSecuritySchemesInPayload(JSON.parse(body)));
  } catch {
    return body;
  }
}

async function handleMcpRequest(request, env, ctx) {
  const requestClone = request.clone();
  let method = "";
  try { method = String((await requestClone.json())?.method || ""); } catch {}
  const auth = await resolveMcpScopes(request, env);
  const response = await createMcpHandler(createServer(env, auth.scopes))(request, env, ctx);
  if (method !== "tools/list" || !response.ok) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const contentType = headers.get("content-type") || "";
  const body = await response.text();
  const promotedBody = promoteRootSecuritySchemesInBody(body, contentType);
  return new Response(promotedBody, { status: response.status, statusText: response.statusText, headers });
}

const oauthProviderSentinelHandler = {
  async fetch() {
    return new Response("Not found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
};

const defaultHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = ACTION_ROUTE_TO_BACKEND[url.pathname];
    if (action) return handleActionRequest(request, env, action);
    if (url.pathname === "/mcp") return handleMcpRequest(request, env, ctx);
    if (url.pathname === "/health") {
      const versionMeta = env.CF_VERSION_METADATA || null;
      return Response.json({
        ok: true,
        service: SERVER_NAME,
        version: SERVER_VERSION,
        releaseId: RELEASE_ID,
        contourVersion: EXPECTED_BACKEND_CONTOUR_VERSION,
        sourceBaseCommit: SOURCE_BASE_COMMIT,
        canonicalSchema: CANONICAL_SCHEMA_ID,
        oauthSecurity: "DIRECT_GITHUB_REDIRECT_STATE_BOUND_V3",
        oneTimeStateStorage: "OAUTH_STATE_DURABLE_OBJECT",
        oauthProviderStorage: "OAUTH_KV",
        scopeEnforcement: SCOPE_ENFORCEMENT,
        mcpAuthMode: MCP_AUTH_MODE,
        backendTokenMode: BACKEND_TOKEN_MODE,
        workerEntrypoint: "src/staging-contour-rc.js",
        environment: "staging",
        origin: MCP_ORIGIN,
        backendConfigured: Boolean(String(env.BBC_BACKEND_URL || "").trim()),
        backendTokenConfigured: Boolean(String(env.BBC_BACKEND_TOKEN || "").trim()),
        actionBridgeVersion: ACTION_BRIDGE_VERSION,
        actionAuthMode: ACTION_AUTH_MODE,
        actionConfigured: Boolean(String(env.GPT_ACTION_KEY || "").trim()),
        actionBodyMaxBytes: ACTION_BODY_MAX_BYTES,
        actionResponseMaxBytes: ACTION_RESPONSE_MAX_BYTES,
        actionContract: Object.values(ACTION_ROUTE_TO_BACKEND),
        oauthConfigured: Boolean(String(env.GITHUB_CLIENT_ID || "").trim() && String(env.GITHUB_CLIENT_SECRET || "").trim() && env.OAUTH_STATE),
        oauthProvider: "github",
        workerVersion: versionMeta ? {
          id: versionMeta.id || null,
          tag: versionMeta.tag || null,
          timestamp: versionMeta.timestamp || null,
        } : null,
        toolContract: TOOL_CONTRACT,
      });
    }
    if (url.pathname === "/authorize") {
      if (request.method === "GET" || request.method === "POST") {
        return beginGitHubAuthorization(request, env);
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }
    if (url.pathname === "/callback" && request.method === "GET") return finishGitHubAuthorization(request, env);
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  // workers-oauth-provider v0.10.3 requires at least one configured protected API route.
  // /mcp intentionally stays in defaultHandler so initialize/tools-list can be discovered
  // before OAuth. Protected tools return an in-band MCP OAuth challenge until the required scope is granted.
  apiRoute: "/__oauth_provider_internal_sentinel",
  apiHandler: oauthProviderSentinelHandler,
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
