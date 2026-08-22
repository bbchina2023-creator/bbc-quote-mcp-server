# ACTIONS-RC-02 local verification

Date: 2026-08-20

## Source preservation

The following files were byte-for-byte preserved from the uploaded ACTIONS-RC-01 package:

- `apps-script/BBC_KP_Generator_Code_v4.2.0_RELEASE_C_RC-CORR-03.gs`
- `src/staging-contour-rc.js`
- `wrangler.contour.jsonc`

Only the Custom GPT Actions transport contract and its tests/docs were changed.

## Verified locally

- `openapi-actions.yaml` parses as OpenAPI 3.1.0.
- Exactly five operationIds remain: `validateCanonicalDeal`, `recalculateDeal`, `getVerifiedSnapshot`, `generateQuote`, `getDealStatus`.
- `validateCanonicalDeal` requires `canonicalDealJson`.
- `recalculateDeal` requires `canonicalDealJson` + `idempotencyKey`.
- `src/action-bridge.js` parses the JSON string into a real object before calling the unchanged backend.
- Invalid JSON, arrays, duplicate object/string canonical transports, unknown fields, oversized payloads, missing Bearer auth, and oversized responses fail closed.
- Targeted Action/OpenAPI tests: 19/19 PASS.
- All locally runnable non-Zod suites: 47/47 PASS.

The sandbox dependency installation could not fully hydrate the `zod` package because the execution environment has no package-registry network access. Therefore the complete `npm test` suite is intentionally re-run and required to PASS by `ACTIONS-RC-02_DEPLOY_STAGING_ONLY.sh` on the deployment Mac before Wrangler dry-run or deployment. The deployment script stops before any deploy if that full suite fails.

## Live acceptance encoded in deploy script

The script does not create or rotate `GPT_ACTION_KEY`. It first proves that an already-existing local key matches the already-configured staging Worker, then deploys only `bbc-quote-mcp-server-staging`, polls health for `ACTIONS-RC-02`, verifies unauthenticated rejection, and performs an authorized read-only `canonicalDealJson:"{}"` probe.

The live success marker is:

`RESULT=ACTIONS-RC-02_STAGING_TRANSPORT_PASS`
