import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  BBC_AGENT_API_KEY: string;
}

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbyE4M_w7OC_fjG9LI0HWjhwOnqGIyygx3ewE1cFminjDeYgBJ-somVqsMMVEX9FFkkq/exec";

const SPREADSHEET_ID =
  "1RUgOSZySiDtClxwZ-aQypwNRgaF3Jj-aMKVHeGQmXF8";

type AppsScriptResponse = {
  success?: boolean;
  dealId?: string;
  fileName?: string;
  fileUrl?: string;
  fileId?: string;
  packageStatus?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
};

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "BBC Quote Generator",
    version: "1.0.0",
  });

  async init() {
    this.server.registerTool(
      "getDealPackage",
      {
        title: "Получить пакет данных сделки BBC",
        description:
          "Получает проверенный пакет данных сделки из BBC КП Generator. " +
          "Использовать перед подготовкой коммерческого предложения.",
        inputSchema: {
          dealId: z
            .string()
            .min(1)
            .describe(
              "Полный deal_id сделки, например BBC-da5f0c0d-8478-4862-8769-1b2f28631a7c",
            ),
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
              apiKey: this.env.BBC_AGENT_API_KEY,
              action: "GENERATE_AI_QUOTE_PACKAGE",
              spreadsheetId: SPREADSHEET_ID,
              dealId: dealId.trim(),
            }),
            redirect: "follow",
          });

          const responseText = await response.text();

          let data: AppsScriptResponse;

          try {
            data = JSON.parse(responseText) as AppsScriptResponse;
          } catch {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    "Apps Script вернул ответ не в формате JSON.\n\n" +
                    `HTTP: ${response.status}\n` +
                    `Ответ: ${responseText.slice(0, 2000)}`,
                },
              ],
            };
          }

          if (!response.ok || data.success !== true) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      httpStatus: response.status,
                      dealId,
                      error:
                        data.error ||
                        data.message ||
                        "BBC КП Generator не выполнил запрос.",
                      rawResponse: data,
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
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    dealId: data.dealId || dealId,
                    packageStatus:
                      data.packageStatus || "PACKAGE_CREATED",
                    fileName: data.fileName || "",
                    fileUrl: data.fileUrl || "",
                    fileId: data.fileId || "",
                    instruction:
                      "Откройте пакет, проверьте данные сделки и сообщите менеджеру о недостающих полях. Не придумывайте отсутствующие значения.",
                    rawResponse: data,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    dealId,
                    error: message,
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
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/health") {
      return Response.json({
        success: true,
        service: "BBC Quote MCP",
        version: "1.0.0",
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
