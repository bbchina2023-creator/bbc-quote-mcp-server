import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

interface Env {
  /** Full Apps Script Web App URL including ?token=... */
  BBC_BACKEND_URL: string;
  /** Secret used by ChatGPT custom app to call this Worker. */
  MCP_API_KEY: string;
}

const SERVER_NAME = "BBC KP Generator";
const SERVER_VERSION = "1.0.0-dev016.39";

const fileRefSchema = z
  .object({
    driveFileId: z.string().min(1).optional(),
    driveUrl: z.string().min(1).optional(),
    fileName: z.string().optional(),
  })
  .refine((value: { driveFileId?: string; driveUrl?: string }) => Boolean(value.driveFileId || value.driveUrl), {
    message: "Нужно передать driveFileId или driveUrl",
  });

const managerAnswerSchema = z.object({
  questionId: z.string().optional(),
  fieldCode: z.string().optional(),
  itemId: z.string().optional(),
  itemNumber: z.number().optional(),
  value: z.unknown().optional(),
  answerText: z.string().optional(),
});

function readApiKey(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }

  return (
    request.headers.get("x-api-key") ||
    request.headers.get("api-key") ||
    request.headers.get("x-access-token") ||
    ""
  ).trim();
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = String(env.MCP_API_KEY || "").trim();
  const actual = readApiKey(request);
  return Boolean(expected) && actual === expected;
}

async function decodeAppsScriptResponse(
  initialResponse: Response,
): Promise<unknown> {
  let response = initialResponse;
  let hops = 0;

  // Apps Script ContentService commonly redirects the response body to
  // script.googleusercontent.com. Follow that redirect explicitly so the
  // original POST is not accidentally replayed as a POST to the redirect URL.
  while ([301, 302, 303, 307, 308].includes(response.status) && hops < 5) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(
        `Apps Script redirect ${response.status} without Location header`,
      );
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
    throw new Error(
      `Apps Script HTTP ${response.status}: ${responseText.slice(0, 1500)}`,
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Apps Script returned non-JSON payload: ${responseText.slice(0, 1500)}`,
    );
  }

  if (!payload || payload.ok !== true) {
    throw new Error(
      String(
        payload?.error ||
          payload?.message ||
          "Apps Script backend returned ok=false",
      ),
    );
  }

  return payload.result;
}

async function callBackend(
  env: Env,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
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
    body: JSON.stringify({
      action,
      arguments: args,
    }),
    redirect: "manual",
  });

  return decodeAppsScriptResponse(response);
}

function successResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "startDealFromFiles",
    {
      title: "Создать сделку из файлов",
      description:
        "Создаёт новую сделку BBC из исходных Excel-файлов текущего чата. " +
        "Перед вызовом сохраните вложения текущего чата в Google Drive и передайте Drive file IDs/URLs. " +
        "Возвращает только реальные вопросы менеджеру либо готовые ссылки на КП.",
      inputSchema: {
        files: z.array(fileRefSchema).min(1),
        managerName: z.string().optional(),
        clientHint: z.string().optional(),
        autoGenerateQuote: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        return successResult(
          await callBackend(env, "startDealFromFiles", args),
        );
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
        "Записывает ответы менеджера на вопросы BBC КП Generator, повторно проверяет gates " +
        "и при готовности автоматически формирует КП.",
      inputSchema: {
        dealId: z.string().min(1),
        answers: z.array(managerAnswerSchema).min(1),
        autoGenerateQuote: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        return successResult(
          await callBackend(env, "submitManagerAnswers", args),
        );
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
        "Формирует Google Sheets, XLSX и PDF только для сделки, прошедшей расчёт и финальный quote gate. " +
        "Возвращает фактические ссылки на документы.",
      inputSchema: {
        dealId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
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
        "Возвращает текущее проверенное состояние сделки, вопросы менеджеру, последний verified snapshot " +
        "и ссылки на уже созданные документы.",
      inputSchema: {
        dealId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: SERVER_NAME,
        version: SERVER_VERSION,
        backendConfigured: Boolean(String(env.BBC_BACKEND_URL || "").trim()),
        authConfigured: Boolean(String(env.MCP_API_KEY || "").trim()),
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    if (!isAuthorized(request, env)) {
      return Response.json(
        { ok: false, error: "Unauthorized" },
        {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="BBC KP Generator MCP"',
          },
        },
      );
    }

    const server = createServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
