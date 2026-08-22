# BBC КП Generator — Release C RC-CORR-05

## Final disposition

`BLOCKED`

The corrected release candidate is deployed and healthy in the isolated staging environment. RC-CORR-05 removes the failing intermediate authorization form. OAuth reconnect has already succeeded, but the existing ChatGPT Business app still exposes its frozen legacy four-tool snapshot. Reconnect cannot change that tool contract. A new Business custom app must scan the current five-tool MCP endpoint before the prescribed control-deal calls. Production was not modified.

## Root cause and correction

The real ChatGPT Business reconnect on 2026-08-20 proved that RC-CORR-04 did not solve the incident: the custom `/authorize` consent form still posted a short-lived one-time consent record and the real browser flow again ended at `CSRF validation failed`. Header compatibility was therefore not the complete root cause. The unstable component was the redundant intermediate application-consent POST itself.

RC-CORR-05 removes that intermediate form and its consent POST from the active staging entrypoint. A valid OAuth authorization request is parsed and its registered client is verified, then the complete request is stored behind a cryptographically random, short-lived, one-time GitHub `state` in `OAUTH_STATE`. A host-only `HttpOnly`, `Secure`, `SameSite=Lax` cookie binds that state to the initiating browser. GitHub performs the user consent; the callback requires both the browser-bound hash and one-time Durable Object record before `OAuthProvider.completeAuthorization()` can run. PKCE remains enforced by the provider.

Live proof after deployment on 2026-08-20: a cross-site top-level authorization request returned HTTP 302 directly to GitHub `/login/oauth/authorize`, included a random `state`, and set the browser-bound state cookie. The deployed active entrypoint contains no `CSRF validation failed` response and no `consent_id` form.

## Changed files

- `src/staging-contour-rc.js` — staging-only five-tool MCP/OAuth entrypoint, fail-closed backend contour-version check, release markers and health evidence.
- `src/canonical-schema.js` — strict canonical boundary validation for authority, payment schedules, manager decisions, rules, item arithmetic and deal-expense allocation.
- `apps-script/BBC_KP_Generator_Code_v4.2.0_RELEASE_C_RC-CORR-03.gs` — Release C backend v4.2.1 / contour v1.0.5-rc-corr-03, deterministic snapshot-bound document safeguards and blocking invariants.
- `contracts/*.schema.json` — machine-readable Canonical Deal, Payment Schedule, Rule Registry and Snapshot v2 contracts.
- `test/rc-corr-03-negative-regression.test.js` — P0 negative regressions and fail-closed integration assertions.
- `package-lock.json` — exact dependency lock.
- `release-manifest.rc-corr-03.json` — release hashes, test evidence and staging deployment identifiers.

## Removed / deprecated

The deployed configuration does not target the historical `staging-contour-reconnect-v2.js` wrapper chain. `src/staging-contour-rc.js` is the single staging entrypoint.

## Test results

- Node unit/integration tests: 34 passed, 0 failed.
- OAuth tests cover secure cookie parsing, one-time GitHub state validation, direct GitHub authorization routing, removal of the intermediate consent POST, strict client lookup and exact five-tool surface.
- MCP contract tests: exactly five tools; legacy four-tool contract absent from the new Worker.
- Embedded Apps Script suites: 4 suites / 15 checks passed.
- Apps Script live `runDocumentContourSelfTest`: PASS, contour `1.0.5-rc-corr-03`.
- Apps Script deployed read-only `getDealStatus`: PASS, backend `4.2.1`, request `REQ-f9e41ccb-4e5c-470b-9d4d-3dab23630385`.
- Worker and Apps Script syntax: PASS.
- Wrangler build/dry-run: PASS.
- Dependency audit: 0 vulnerabilities.

## Deployment

- Git source base: `0e4b1851871c8c3dcd4c11765468f7a3f96f91e1`.
- Local release branch: `codex/rc-corr-03` (not committed or pushed without explicit authorization).
- Apps Script staging deployment: version 8, deployment ID `AKfycbwAYxOiiWNsLnlspEYQfvlJKipSGJjeWdWIeKGlnsTJZRUM4zSsiyGSbVhaUT84Yws7`.
- Cloudflare Worker: `bbc-quote-mcp-server-staging`.
- Cloudflare version: `10a7a181-3d4b-4904-bbc4-c3202a0aeaf1`.
- Staging traffic: 100%.
- Health: `ok=true`, release `RC-CORR-05`, Worker `1.0.3-rc-corr-05-staging`, OAuth security `DIRECT_GITHUB_REDIRECT_STATE_BOUND_V3`, backend contour `1.0.5-rc-corr-03`.
- Rollback point: the immediately preceding staging deployment remains available in Cloudflare deployment history.

## ChatGPT E2E

- OAuth discovery: PASS.
- Dynamic client registration: PASS.
- Direct authorization redirect: PASS; HTTP 302 to GitHub with one-time state and browser-bound cookie.
- Intermediate consent form/POST: removed from the active entrypoint.
- GitHub consent/callback in the authorized ChatGPT Business user session: PASS.
- Existing Business app tool contract: FAIL — frozen legacy four-tool snapshot.
- New Business app scan and control-deal MCP calls: pending.

### Confirmed FINAL RC-CORR-05 draft failure — 2026-08-20

- ChatGPT created a new DCR client in `OAUTH_KV` at `2026-08-20 13:45:58 CST` for the `BBC КП Generator — FINAL RC-CORR-05` draft.
- No corresponding OAuth grant was created for that client.
- The draft consequently persisted with `0 actions` and is invalid for testing or publication.
- Live staging verification at `2026-08-20 14:20 CST` confirmed HTTP 200 health, active Cloudflare version `10a7a181-3d4b-4904-bbc4-c3202a0aeaf1`, valid protected-resource metadata, valid authorization-server metadata, and the expected five-tool contract.
- Root cause is therefore not Worker deployment, MCP tool registration, OAuth discovery, DCR, backend configuration, or production. The user authorization step for this specific DCR client was not completed before the draft was saved.
- Required recovery: create one replacement draft and complete the displayed `Войти через …` OAuth action before leaving the creation flow. Do not publish or reuse the zero-action draft.

## Required final acceptance sequence

In the `Big Business China` workspace create a new custom app named `BBC КП Generator — FINAL RC-CORR-05` using `https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev/mcp`, OAuth and DCR. During creation scan tools and complete GitHub OAuth. The new app must show exactly:

1. `validateCanonicalDeal`
2. `recalculateDeal`
3. `getVerifiedSnapshot`
4. `generateQuote`
5. `getDealStatus`

Then execute against control deal `BBC-15af9054-0cfd-414e-b0c9-90a50ac6d2a6`: `getDealStatus`, `getVerifiedSnapshot`, and `generateQuote` from the returned VERIFIED Snapshot v2. Confirm `quoteContextSource=SNAPSHOT_V2`, `rawImportReadsAfterSnapshot=0`, `recalculationAfterSnapshot=false`, `outputProfile=FULL_MASTER_WORKBOOK`, and accepted Google Sheets/XLSX/PDF artifacts.

## Security

- No credentials are stored in repository files or this report.
- OAuth state is cryptographically random, one-time, TTL-bound, server-validated and browser-bound.
- PKCE remains required.
- GitHub access remains limited to the configured owner ID.
- Backend credential is sent in the JSON body and stored only as a Cloudflare secret.

## Production

`NOT MODIFIED`

## Single confirmed blocker

The current session must be given authorized interactive access to the `Big Business China` workspace so it can create one new custom app and run the single control-deal E2E. The legacy four-tool app must not be reconnected or refreshed again. No additional Cloudflare, GitHub App or Apps Script configuration change is required before creating the new app.

## RC-CORR-06 — ChatGPT Business discovery compatibility candidate

Status: `PREPARED_NOT_DEPLOYED`.

After the `FINAL RC-CORR-05` Business draft was created with zero actions, the remaining incompatibility was isolated to the ordering boundary between ChatGPT Business tool scanning and server-wide OAuth enforcement. RC-CORR-05 protected the entire `/mcp` route, so an unauthenticated scanner could not complete `initialize` / `tools/list` unless the UI first completed OAuth. The actual Business UI shown during acceptance did not complete that sequence and persisted an empty draft.

RC-CORR-06 changes only the staging Worker transport/auth boundary. It does not change Apps Script, the calculation engine, Canonical Deal rules, Snapshot v2, document generation, Cloudflare bindings, OAuth provider metadata, DCR, GitHub identity policy, or production.

The candidate follows the MCP per-tool authorization pattern: MCP protocol discovery is reachable without a bearer token, while every `tools/call` is intercepted before the MCP handler and returns HTTP 401 plus `WWW-Authenticate` / protected-resource metadata unless a valid resource-bound OAuth token is present. The five tool handlers retain their `quote.read`, `quote.write`, and `quote.generate` scope checks as defence in depth. Token audience must equal the canonical staging MCP resource.

Candidate markers:

- Worker version: `1.0.4-rc-corr-06-staging`.
- Release ID: `RC-CORR-06`.
- MCP auth mode: `PUBLIC_DISCOVERY_PROTECTED_TOOL_CALLS_V1`.
- Backend contour remains: `1.0.5-rc-corr-03`.
- Staging Worker remains: `bbc-quote-mcp-server-staging`.
- Production target: not modified / not permitted.

Local verification completed in the audit sandbox:

- `node --check src/staging-contour-rc.js`: PASS.
- Worker/OAuth targeted tests: 28 PASS / 0 FAIL.
- The previously proven RC-CORR-05 full suite remains parent evidence; the RC-CORR-03 schema regression file was not re-executed in this audit sandbox because its npm dependency (`zod`) is not installed here. The staging deploy script therefore runs an exact `npm ci`, the targeted RC-CORR-06 suite and Wrangler dry-run before permitting deployment.

Deployment is deliberately direct to the isolated staging Worker and does not use Git push, merge, or the historical Cloudflare Git integration. The provided `RC-CORR-06_DEPLOY_STAGING_ONLY.sh` fails closed unless the target is exactly `bbc-quote-mcp-server-staging`, verifies source SHA, installs from `package-lock.json`, runs the changed-area tests, performs Wrangler dry-run, deploys, then proves three live gates: health identifies RC-CORR-06; anonymous `initialize` and `tools/list` expose exactly the five final tools; unauthenticated `tools/call` returns HTTP 401 with an OAuth challenge.

Only after those live gates pass may a replacement Business draft be created. If ChatGPT can now scan the five tools, the first protected call is expected to trigger the normal OAuth flow. The final control-deal E2E and production promotion remain unchanged.


## RC-CORR-06A provider-constructor correction — 2026-08-20

RC-CORR-06 did not deploy. Wrangler stopped before deployment with Cloudflare validation error 10021 because `@cloudflare/workers-oauth-provider` v0.10.3 requires `apiRoute + apiHandler` or `apiHandlers`. RC-CORR-06A adds a deliberately unused OAuth-protected sentinel route (`/__oauth_provider_internal_sentinel`) with a 404 handler solely to satisfy the provider constructor. The real `/mcp` path remains in `defaultHandler`, preserving public protocol discovery for `initialize` and `tools/list`, while `tools/call` remains OAuth-protected at the HTTP boundary and by per-tool scopes. Targeted syntax/OAuth/wiring suite: 28/28 PASS. Production and Apps Script remain unchanged.

## RC-CORR-06C — pending staging deploy
After RC-CORR-06A proved public discovery (`initialize=200`, exact five `tools/list`) but ChatGPT Business still persisted `0 actions`, the remaining interoperability defect was traced to tool descriptor authentication metadata. The pinned MCP TypeScript SDK v1.29.0 serializes `securitySchemes` only in `_meta`, while current OpenAI Apps SDK guidance expects first-class `securitySchemes` on each tool and a compatibility mirror in `_meta`. RC-CORR-06C promotes exact per-tool OAuth schemes into the wire `tools/list` response and adds a standards-aligned in-band OAuth challenge containing `error` and `error_description`. Apps Script and production remain untouched. Status: candidate prepared; staging deploy required.
