import OAuthProvider, {
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

interface Env {
  BBC_BACKEND_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

const SERVER_NAME = "BBC KP Generator";
const SERVER_VERSION = "1.0.0-dev016.40-staging-secure3";
const MCP_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const GITHUB_CALLBACK = `${MCP_ORIGIN}/callback`;
const GITHUB_STATE_PREFIX = "bbc:oauth:github-state:";
const CONSENT_STATE_PREFIX = "bbc:oauth:consent:";
const OAUTH_FLOW_TTL_SECONDS = 10 * 60;
const CSRF_COOKIE_PREFIX = "__Host-BBC_MCP_CSRF_";
const STATE_COOKIE_PREFIX = "__Host-BBC_MCP_STATE_";
const ALLOWED_GITHUB_USER_ID = 307006935;
const SUPPORTED_SCOPES = ["quote.read", "quote.write", "quote.generate"];

const fileRefSchema = z
  .object({
    driveFileId: z.string().min(1).optional(),
    driveUrl: z.string().min(1).optional(),
    fileName: z.string().optional(),
  })
  .refine(
    (value: { driveFileId?: string; driveUrl?: string }) =>
      Boolean(value.driveFileId || value.driveUrl),
    { message: "Нужно передать driveFileId или driveUrl" },
  );

const managerAnswerSchema = z.object({
  questionId: z.string().optional(),
  fieldCode: z.string().optional(),
  itemId: z.string().optional(),
  itemNumber: z.number().optional(),
  value: z.unknown().optional(),
  answerText: z.string().optional(),
});

async function decodeAppsScriptResponse(initialResponse: Response): Promise<unknown> {
  let response = initialResponse;
  let hops = 0;

  while ([301, 302, 303, 307, 308].includes(response.status) && hops < 5) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Apps Script redirect ${response.status} without Location header`);
    }
    response = await fetch(location, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    hops += 1;
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Apps Script HTTP ${response.status}: ${responseText.slice(0, 1500)}`);
  }

  let payload: any;
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

async function callBackend(env: Env, action: string, args: Record<string, unknown>): Promise<unknown> {
  const backendUrl = String(env.BBC_BACKEND_URL || "").trim();
  if (!backendUrl) {
    throw new Error("BBC_BACKEND_URL secret is not configured");
  }

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ action, arguments: args }),
    redirect: "manual",
  });

  return decodeAppsScriptResponse(response);
}

function successResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      },
    ],
  };
}

function createServer(env: Env) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "startDealFromFiles",
    {
      title: "Создать сделку из файлов",
      description:
        "Создаёт новую сделку BBC из исходных Excel-файлов текущего чата. Перед вызовом сохраните вложения текущего чата в Google Drive и передайте Drive file IDs/URLs. Возвращает только реальные вопросы менеджеру либо готовые ссылки на КП.",
      inputSchema: {
        files: z.array(fileRefSchema).min(1),
        managerName: z.string().optional(),
        clientHint: z.string().optional(),
        autoGenerateQuote: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return successResult(await callBackend(env, "startDealFromFiles", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "submitManagerAnswers",
    {
      title: "Записать ответы менеджера",
      description:
        "Записывает ответы менеджера на вопросы BBC КП Generator, повторно проверяет gates и при готовности автоматически формирует КП.",
      inputSchema: {
        dealId: z.string().min(1),
        answers: z.array(managerAnswerSchema).min(1),
        autoGenerateQuote: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return successResult(await callBackend(env, "submitManagerAnswers", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "generateQuote",
    {
      title: "Сформировать КП",
      description:
        "Формирует Google Sheets, XLSX и PDF только для сделки, прошедшей расчёт и финальный quote gate. Возвращает фактические ссылки на документы.",
      inputSchema: { dealId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return successResult(await callBackend(env, "generateQuote", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getDealPackage",
    {
      title: "Получить состояние сделки",
      description:
        "Возвращает текущее проверенное состояние сделки, вопросы менеджеру, последний verified snapshot и ссылки на уже созданные документы.",
      inputSchema: { dealId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return successResult(await callBackend(env, "getDealPackage", args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function requireOAuthConfiguration(env: Env): void {
  if (!String(env.GITHUB_CLIENT_ID || "").trim()) {
    throw new Error("GITHUB_CLIENT_ID is not configured");
  }
  if (!String(env.GITHUB_CLIENT_SECRET || "").trim()) {
    throw new Error("GITHUB_CLIENT_SECRET secret is not configured");
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const rawCookie of cookieHeader.split(";")) {
    const cookie = rawCookie.trim();
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator) === name) {
      return cookie.slice(separator + 1);
    }
  }
  return null;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function csrfCookieName(consentId: string): string {
  return `${CSRF_COOKIE_PREFIX}${consentId}`;
}

function stateCookieName(state: string): string {
  return `${STATE_COOKIE_PREFIX}${state}`;
}

function htmlHeaders(setCookies: string[] = []): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return headers;
}

function textResponse(body: string, status: number, setCookies: string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function showAuthorizationConsent(request: Request, env: Env): Promise<Response> {
  requireOAuthConfiguration(env);

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return textResponse("Invalid authorization request", 400);
  }

  const clientId = String(oauthRequest.clientId || "").trim();
  if (!clientId) {
    return textResponse("Missing OAuth client ID", 400);
  }

  let client: any = null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(clientId);
  } catch {
    return textResponse("Unknown OAuth client", 400);
  }

  const consentId = crypto.randomUUID();
  await env.OAUTH_KV.put(`${CONSENT_STATE_PREFIX}${consentId}`, JSON.stringify(oauthRequest), {
    expirationTtl: OAUTH_FLOW_TTL_SECONDS,
  });

  const csrfToken = crypto.randomUUID();
  const csrfCookie = secureCookie(csrfCookieName(consentId), csrfToken, OAUTH_FLOW_TTL_SECONDS);
  const requestedScopes = Array.isArray(oauthRequest.scope) ? oauthRequest.scope : [];
  const clientName =
    String(client?.clientName || client?.client_name || client?.name || "").trim() || clientId;
  const scopeText = requestedScopes.length > 0 ? requestedScopes.join(", ") : "Нет дополнительных scopes";

  const body = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BBC KP Generator — подтверждение доступа</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1f2937; }
    main { max-width: 680px; margin: 8vh auto; background: white; padding: 32px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
    h1 { margin-top: 0; font-size: 24px; }
    .meta { background: #f3f4f6; padding: 16px; border-radius: 10px; margin: 20px 0; }
    .row { margin: 8px 0; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    button { border: 0; border-radius: 9px; padding: 11px 18px; font-size: 15px; cursor: pointer; }
    .approve { background: #111827; color: white; }
    .deny { background: #e5e7eb; color: #111827; }
    p { line-height: 1.55; }
  </style>
</head>
<body>
<main>
  <h1>Разрешить доступ к BBC KP Generator?</h1>
  <p>MCP-клиент запрашивает доступ к инструментам BBC КП Generator. После подтверждения вы перейдёте на GitHub для входа.</p>
  <div class="meta">
    <div class="row"><strong>Клиент:</strong> ${escapeHtml(clientName)}</div>
    <div class="row"><strong>Client ID:</strong> ${escapeHtml(clientId)}</div>
    <div class="row"><strong>Запрошенные права:</strong> ${escapeHtml(scopeText)}</div>
  </div>
  <form method="post" action="/authorize">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
    <input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
    <div class="actions">
      <button class="approve" type="submit" name="decision" value="approve">Разрешить</button>
      <button class="deny" type="submit" name="decision" value="deny">Отменить</button>
    </div>
  </form>
</main>
</body>
</html>`;

  return new Response(body, { status: 200, headers: htmlHeaders([csrfCookie]) });
}

async function handleAuthorizationConsent(request: Request, env: Env): Promise<Response> {
  requireOAuthConfiguration(env);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return textResponse("Invalid consent form", 400);
  }

  const consentId = String(formData.get("consent_id") || "").trim();
  if (!consentId) {
    return textResponse("Missing consent state", 400);
  }

  const csrfName = csrfCookieName(consentId);
  const csrfFromForm = String(formData.get("csrf_token") || "");
  const csrfFromCookie = readCookie(request, csrfName);
  const clearCsrf = secureCookie(csrfName, "", 0);
  if (!csrfFromForm || !csrfFromCookie || csrfFromForm !== csrfFromCookie) {
    return textResponse("CSRF validation failed", 400, [clearCsrf]);
  }

  const consentKey = `${CONSENT_STATE_PREFIX}${consentId}`;
  const serialized = await env.OAUTH_KV.get(consentKey);
  if (!serialized) {
    return textResponse("Expired or invalid consent state", 400, [clearCsrf]);
  }

  if (String(formData.get("decision") || "") !== "approve") {
    await env.OAUTH_KV.delete(consentKey);
    return textResponse("Authorization cancelled", 403, [clearCsrf]);
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(serialized) as AuthRequest;
  } catch {
    return textResponse("Invalid stored authorization request", 400, [clearCsrf]);
  }

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(
    `${GITHUB_STATE_PREFIX}${state}`,
    JSON.stringify({ oauthRequest, consentId }),
    { expirationTtl: OAUTH_FLOW_TTL_SECONDS },
  );

  const stateHash = await sha256Hex(state);
  const stateCookie = secureCookie(stateCookieName(state), stateHash, OAUTH_FLOW_TTL_SECONDS);

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", GITHUB_CALLBACK);
  githubUrl.searchParams.set("scope", "read:user user:email");
  githubUrl.searchParams.set("state", state);

  const headers = new Headers({
    "cache-control": "no-store",
    location: githubUrl.toString(),
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", clearCsrf);
  headers.append("set-cookie", stateCookie);
  return new Response(null, { status: 302, headers });
}

type GitHubUser = { id: number; login: string };

async function exchangeGitHubCode(code: string, env: Env): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "BBC-KP-Generator-MCP",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: GITHUB_CALLBACK,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!payload.access_token) {
    throw new Error(payload.error_description || payload.error || "GitHub access token missing");
  }
  return payload.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "BBC-KP-Generator-MCP",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
  }
  return (await response.json()) as GitHubUser;
}

async function finishGitHubAuthorization(request: Request, env: Env): Promise<Response> {
  requireOAuthConfiguration(env);

  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") || "").trim();
  if (!state) {
    return textResponse("Missing GitHub OAuth state", 400);
  }

  const stateKey = `${GITHUB_STATE_PREFIX}${state}`;
  const serialized = await env.OAUTH_KV.get(stateKey);
  if (!serialized) {
    return textResponse("Expired or invalid GitHub OAuth state", 400);
  }

  const expectedStateHash = await sha256Hex(state);
  const stateName = stateCookieName(state);
  const stateHashFromCookie = readCookie(request, stateName);
  const clearStateCookie = secureCookie(stateName, "", 0);
  if (!stateHashFromCookie || stateHashFromCookie !== expectedStateHash) {
    return textResponse("OAuth state is not bound to this browser session", 400, [clearStateCookie]);
  }

  await env.OAUTH_KV.delete(stateKey);

  let oauthRequest: AuthRequest;
  let consentId = "";
  try {
    const parsed = JSON.parse(serialized) as any;
    if (parsed && typeof parsed === "object" && parsed.oauthRequest) {
      oauthRequest = parsed.oauthRequest as AuthRequest;
      consentId = String(parsed.consentId || "").trim();
    } else {
      oauthRequest = parsed as AuthRequest;
    }
  } catch {
    return textResponse("Invalid stored OAuth request", 400, [clearStateCookie]);
  }

  if (consentId) {
    await env.OAUTH_KV.delete(`${CONSENT_STATE_PREFIX}${consentId}`);
  }

  const githubError = url.searchParams.get("error");
  if (githubError) {
    return textResponse(`GitHub authorization failed: ${githubError}`, 403, [clearStateCookie]);
  }

  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) {
    return textResponse("Missing GitHub OAuth code", 400, [clearStateCookie]);
  }

  try {
    const githubAccessToken = await exchangeGitHubCode(code, env);
    const user = await fetchGitHubUser(githubAccessToken);
    if (user.id !== ALLOWED_GITHUB_USER_ID) {
      return textResponse(
        "This GitHub account is not authorized for BBC KP Generator",
        403,
        [clearStateCookie],
      );
    }

    const requestedScopes = Array.isArray(oauthRequest.scope) ? oauthRequest.scope : [];
    const grantedScopes = requestedScopes.filter((scope) => SUPPORTED_SCOPES.includes(scope));

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: String(user.id),
      metadata: { identityProvider: "github", githubLogin: user.login },
      scope: grantedScopes,
      props: { githubUserId: user.id, githubLogin: user.login },
    });

    const headers = new Headers({
      "cache-control": "no-store",
      location: redirectTo,
      "referrer-policy": "no-referrer",
    });
    headers.append("set-cookie", clearStateCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return textResponse(error instanceof Error ? error.message : String(error), 500, [clearStateCookie]);
  }
}

const mcpApiHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    return createMcpHandler(createServer(env))(request, env, ctx);
  },
};

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: SERVER_NAME,
        version: SERVER_VERSION,
        environment: "staging",
        origin: MCP_ORIGIN,
        backendConfigured: Boolean(String(env.BBC_BACKEND_URL || "").trim()),
        oauthConfigured: Boolean(
          String(env.GITHUB_CLIENT_ID || "").trim() &&
            String(env.GITHUB_CLIENT_SECRET || "").trim(),
        ),
        oauthProvider: "github",
        oauthSecurity: "consent+csrf+session-bound-state+flow-isolated-cookies+retry-safe-consent-state",
      });
    }
    if (url.pathname === "/authorize") {
      if (request.method === "GET") return showAuthorizationConsent(request, env);
      if (request.method === "POST") return handleAuthorizationConsent(request, env);
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      return finishGitHubAuthorization(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: SUPPORTED_SCOPES,
  allowPlainPKCE: false,
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ORIGIN],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: SERVER_NAME,
  },
});
