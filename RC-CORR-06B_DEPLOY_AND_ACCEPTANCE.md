# RC-CORR-06B — staging-only ChatGPT Business interoperability

## Purpose
RC-CORR-06B keeps anonymous MCP discovery while moving the authentication challenge for protected tools into the MCP `tools/call` result using `_meta["mcp/www_authenticate"]`. This is the documented ChatGPT tool-level OAuth trigger and avoids relying on a bare HTTP 401 during the broken Business app-creation OAuth scan flow.

## Security boundary
- `initialize` and `tools/list`: public metadata only.
- Protected tool execution: backend is never called without the required OAuth scope.
- Missing/invalid authorization produces an in-band MCP OAuth challenge.
- OAuth tokens remain resource/audience-bound to the staging `/mcp` resource.
- Apps Script and production are unchanged.

## ChatGPT creation fallback after deployment
If the Business OAuth creation form still fails to persist a draft, create the app with **Authentication = No authentication** so the tool scan is not blocked by the broken OAuth-creation flow. The first protected tool invocation must then return the MCP OAuth challenge and start OAuth. Do not publish until all five tools are visible and a protected tool successfully completes OAuth.

## Expected live deploy result
`RESULT=RC-CORR-06B_STAGING_DEPLOYED_AND_INBAND_AUTH_GATE_PASS`
