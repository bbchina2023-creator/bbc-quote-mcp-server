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
const SERVER_VERSION = "1.0.0-dev016.40-staging";
const MCP_ORIGIN = "https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev";
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const GITHUB_CALLBACK = `${MCP_ORIGIN}/callback`;
const GITHUB_STATE_PREFIX = "bbc:oauth:github-state:";
const GITHUB_STATE_TTL_SECONDS = 10 * 60;
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

async function beginGitHubAuthorization(request: Request, env: Env): Promise<Response> {
  requireOAuthConfiguration(env);

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return new Response("Invalid authorization request", { status: 400 });
  }

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`${GITHUB_STATE_PREFIX}${state}`, JSON.stringify(oauthRequest), {
    expirationTtl: GITHUB_STATE_TTL_SECONDS,
  });

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", GITHUB_CALLBACK);
  githubUrl.searchParams.set("scope", "read:user user:email");
  githubUrl.searchParams.set("state", state);

  return Response.redirect(githubUrl.toString(), 302);
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
  const githubError = url.searchParams.get("error");
  if (githubError) {
    return new Response(`GitHub authorization failed: ${githubError}`, { status: 403 });
  }

  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  if (!code || !state) {
    return new Response("Missing GitHub OAuth code/state", { status: 400 });
  }

  const stateKey = `${GITHUB_STATE_PREFIX}${state}`;
  const serialized = await env.OAUTH_KV.get(stateKey);
  await env.OAUTH_KV.delete(stateKey);
  if (!serialized) {
    return new Response("Expired or invalid GitHub OAuth state", { status: 400 });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(serialized) as AuthRequest;
  } catch {
    return new Response("Invalid stored OAuth request", { status: 400 });
  }

  try {
    const githubAccessToken = await exchangeGitHubCode(code, env);
    const user = await fetchGitHubUser(githubAccessToken);
    if (user.id !== ALLOWED_GITHUB_USER_ID) {
      return new Response("This GitHub account is not authorized for BBC KP Generator", {
        status: 403,
      });
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

    return Response.redirect(redirectTo, 302);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
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
      });
    }
    if (url.pathname === "/authorize") return beginGitHubAuthorization(request, env);
    if (url.pathname === "/callback") return finishGitHubAuthorization(request, env);
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
