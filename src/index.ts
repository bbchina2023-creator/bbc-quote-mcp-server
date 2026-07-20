import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

interface Env {
  BBC_AGENT_API_KEY: string;
}

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbyE4M_w7OC_fjG9LI0HWjhwOnqGIyygx3ewE1cFminjDeYgBJ-somVqsMMVEX9FFkkq/exec";

const SPREADSHEET_ID =
  "1RUgOSZySiDtClxwZ-aQypwNRgaF3Jj-aMKVHeGQmXF8";

function createServer(env: Env) {
  const server = new McpServer({
    name: "BBC Quote Generator",
    version: "1.0.1",
  });

  server.registerTool(
    "getDealPackage",
    {
      title: "Получить пакет данных сделки BBC",
      description:
        "Получает проверенный пакет данных сделки из BBC КП Generator.",
      inputSchema: {
        dealId: z
          .string()
          .min(1)
          .describe("Полный идентификатор сделки BBC"),
      },
    },
    async ({ dealId }) => {
      try {
        const response = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: env.BBC_AGENT_API_KEY,
            action: "GENERATE_AI_QUOTE_PACKAGE",
            spreadsheetId: SPREADSHEET_ID,
            dealId: dealId.trim(),
          }),
          redirect: "follow",
        });

        const responseText = await response.text();

        let data: Record<string, unknown>;

        try {
          data = JSON.parse(responseText);
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    error: "Apps Script вернул ответ не в формате JSON",
                    httpStatus: response.status,
                    response: responseText.slice(0, 2000),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (!response.ok || data.success !== true) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    dealId,
                    httpStatus: response.status,
                    response: data,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  dealId,
                  error:
                    error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
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
        success: true,
        service: "BBC Quote MCP",
        version: "1.0.1",
      });
    }

    if (url.pathname === "/mcp") {
      const server = createServer(env);
      return createMcpHandler(server)(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
