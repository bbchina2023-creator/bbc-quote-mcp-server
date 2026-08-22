# RC-CORR-06 — staging-only deployment and acceptance

This package is a narrow compatibility correction for the final ChatGPT Business app scan. It is based on the uploaded RC-CORR-05 workspace and preserves the RC-CORR-03 backend / Apps Script candidate.

## What changes

Only `src/staging-contour-rc.js` and two Worker contract tests are changed relative to RC-CORR-05 for this correction:

- MCP protocol discovery can reach `initialize` and `tools/list` without a bearer token.
- Every `tools/call` remains protected at the HTTP boundary and returns OAuth HTTP 401 when unauthenticated.
- Authenticated calls require a token bound to the exact staging MCP resource.
- Existing per-tool scopes remain enforced inside all five handlers.

This implements the documented MCP per-tool authorization model while keeping all BBC data/actions protected.

## Safety boundary

- Direct deploy only.
- Target must be `bbc-quote-mcp-server-staging`.
- No Git push or merge before staging PASS.
- No production Worker, Apps Script production deployment, or old ChatGPT app is modified.

## One command on the authorized Mac

After extracting this package, run the included `RC-CORR-06A_DEPLOY_STAGING_ONLY.sh` from Terminal. The script refuses to deploy if the staging target or source SHA is wrong. It performs dependency lock install, changed-area tests, Wrangler dry-run, direct staging deployment, live anonymous tool discovery, and a live negative test proving unauthenticated tool execution receives an OAuth 401 challenge.

The only acceptable final line is:

`RESULT=RC-CORR-06A_STAGING_DEPLOYED_AND_DISCOVERY_GATE_PASS`

If the script stops earlier, do not create another ChatGPT draft and do not touch production.

## After PASS

Create one new Business draft pointing at the same staging endpoint. The scan must freeze exactly:

1. `validateCanonicalDeal`
2. `recalculateDeal`
3. `getVerifiedSnapshot`
4. `generateQuote`
5. `getDealStatus`

Then connect/OAuth when ChatGPT prompts on the protected tool call and run the already-approved control sequence on deal `BBC-15af9054-0cfd-414e-b0c9-90a50ac6d2a6`:

`getDealStatus → getVerifiedSnapshot → generateQuote`

No new deal, no repeat import, no architecture changes.

## RC-CORR-06A packaging correction

The first RC-CORR-06 archive failed Wrangler validation before deployment because `@cloudflare/workers-oauth-provider` v0.10.3 requires either `apiRoute + apiHandler` or `apiHandlers` in the provider constructor. The corrected package adds an inert, OAuth-protected sentinel route (`/__oauth_provider_internal_sentinel`) solely to satisfy that provider invariant. `/mcp` remains handled by `defaultHandler`; anonymous `initialize` and `tools/list` remain discoverable, while every `tools/call` still requires a resource-bound OAuth token. No production target or Apps Script code is changed.
