import baseWorker from "./staging";

interface Env {
  BBC_BACKEND_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
}

type CsrfDiagnostics = {
  cookieHeaderPresent: boolean;
  cookieCount: number;
  consentIdPresent: boolean;
  csrfFormTokenPresent: boolean;
  expectedCookiePresent: boolean;
  originHeaderPresent: boolean;
  originMatchesRequestOrigin: boolean;
  refererHeaderPresent: boolean;
  refererMatchesRequestOrigin: boolean;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
};

function cookieNames(request: Request): string[] {
  const header = request.headers.get("cookie") || "";
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return index >= 0 ? part.slice(0, index) : part;
    });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    let diagnostics: CsrfDiagnostics | null = null;

    if (request.method === "POST" && new URL(request.url).pathname === "/authorize") {
      const probe = request.clone();
      const form = await probe.formData();
      const consentId = String(form.get("consent_id") || "").trim();
      const csrfFromForm = String(form.get("csrf_token") || "");
      const names = cookieNames(request);
      const expectedCookieName = consentId ? `__Host-BBC_MCP_CSRF_${consentId}` : "";
      const origin = request.headers.get("origin");
      const referer = request.headers.get("referer");
      const requestOrigin = new URL(request.url).origin;

      diagnostics = {
        cookieHeaderPresent: Boolean(request.headers.get("cookie")),
        cookieCount: names.length,
        consentIdPresent: Boolean(consentId),
        csrfFormTokenPresent: Boolean(csrfFromForm),
        expectedCookiePresent: Boolean(expectedCookieName && names.includes(expectedCookieName)),
        originHeaderPresent: Boolean(origin),
        originMatchesRequestOrigin: origin === requestOrigin,
        refererHeaderPresent: Boolean(referer),
        refererMatchesRequestOrigin: Boolean(referer && referer.startsWith(`${requestOrigin}/`)),
        secFetchSite: request.headers.get("sec-fetch-site"),
        secFetchMode: request.headers.get("sec-fetch-mode"),
        secFetchDest: request.headers.get("sec-fetch-dest"),
      };
    }

    const handler = baseWorker as unknown as ExportedHandler<Env>;
    const response = await handler.fetch!(request, env, ctx);

    if (diagnostics && response.status === 400) {
      const body = await response.clone().text();
      if (body.includes("CSRF validation failed")) {
        return Response.json(
          {
            error: "CSRF validation failed",
            diagnostics,
          },
          {
            status: 400,
            headers: {
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
    }

    return response;
  },
};

export default worker;
