# ACTIONS-RC-01 — staging acceptance contract

Purpose: add a Custom GPT Actions transport to the existing isolated staging Worker without changing the deterministic Apps Script calculation/document core and without changing the already-accepted RC-CORR-06C MCP behavior.

## Scope

Added only:

- five `POST /actions/*` REST routes;
- separate Bearer secret `GPT_ACTION_KEY`;
- bounded request/response envelopes (90,000 bytes);
- exact argument allowlists and idempotency-key gates;
- compact Snapshot retrieval only (`includePayload=false` is enforced server-side);
- OpenAPI 3.1 schema for the five final operations;
- staging-only deploy/acceptance script.

The Apps Script file is unchanged from `BBC_KP_Generator_Code_v4.2.0_RELEASE_C_RC-CORR-03.gs`.

## Exact Action contract

1. `validateCanonicalDeal({canonicalDeal})`
2. `recalculateDeal({canonicalDeal,idempotencyKey})`
3. `getVerifiedSnapshot({snapshotId})` OR `getVerifiedSnapshot({dealId})`
4. `generateQuote({snapshotId,outputProfile:"FULL_MASTER_WORKBOOK",idempotencyKey})`
5. `getDealStatus({dealId})`

## Security contract

- No Action route reaches Apps Script without `Authorization: Bearer <GPT_ACTION_KEY>`.
- `GPT_ACTION_KEY` is independent from `BBC_BACKEND_TOKEN`.
- `BBC_BACKEND_TOKEN` stays only in the Worker secret store and is never returned to Custom GPT.
- Unknown fields fail closed before backend invocation.
- Full Snapshot payload is not exposed through Actions.
- Oversized requests/responses fail closed.

## Acceptance gates

`ACTIONS-RC-01_DEPLOY_STAGING_ONLY.sh` must prove:

- exact staging Worker target;
- source SHA guards;
- full regression suite;
- Wrangler dry-run;
- separate secret creation;
- staging deploy only;
- health identity: RC-CORR-06C + ACTIONS-RC-01;
- unauthenticated Action => HTTP 401;
- authorized `getDealStatus` => current control Snapshot;
- authorized compact `getVerifiedSnapshot` => no full payload;
- `generateQuote` on the already-approved control Snapshot completes below the 40s safety gate and returns:
  - `quoteContextSource=SNAPSHOT_V2`
  - `rawImportReadsAfterSnapshot=0`
  - `recalculationAfterSnapshot=false`
  - `outputProfile=FULL_MASTER_WORKBOOK`
  - Google Sheets/XLSX/PDF links.

Final success marker:

`RESULT=ACTIONS-RC-01_STAGING_LIVE_ACCEPTANCE_PASS`

Only after that marker may the OpenAPI schema be pasted into Custom GPT Actions.
