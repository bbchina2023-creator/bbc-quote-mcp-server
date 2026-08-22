# ACTIONS-RC-02 — Canonical JSON transport compatibility fix

Purpose: fix the only proven Custom GPT Actions compatibility defect without changing the deterministic Apps Script core, the accepted RC-CORR-06C MCP contour, the five Action operationIds, or production.

## Proven defect before this fix

The same staging endpoint behaved differently depending on caller transport:

- direct HTTP `{"canonicalDeal":{}}` reached Apps Script as an object and returned normal Canonical Deal schema issues;
- Custom GPT Actions displayed `canonicalDeal: {...}` before approval but Apps Script returned `canonicalDeal must be an object`;
- therefore the defect is at the Custom GPT nested-object request serialization boundary, not in Worker authentication, routing, Apps Script parsing, or deterministic calculation logic.

## Fix

The public Custom GPT OpenAPI contract now transports Canonical Deal as a bounded JSON string:

1. `validateCanonicalDeal({canonicalDealJson})`
2. `recalculateDeal({canonicalDealJson,idempotencyKey})`

The Worker parses `canonicalDealJson` with `JSON.parse`, rejects invalid/non-object JSON fail-closed, and forwards the resulting object to the unchanged backend as `canonicalDeal`.

Backward-compatible direct object transport (`canonicalDeal`) remains accepted by the Worker but is no longer advertised to Custom GPT.

The other three Actions are unchanged:

3. `getVerifiedSnapshot({snapshotId})` OR `getVerifiedSnapshot({dealId})`
4. `generateQuote({snapshotId,outputProfile:"FULL_MASTER_WORKBOOK",idempotencyKey})`
5. `getDealStatus({dealId})`

## Safety invariants

- staging Worker target only: `bbc-quote-mcp-server-staging`;
- Apps Script file unchanged;
- RC-CORR-06C MCP identity and routes unchanged;
- existing `GPT_ACTION_KEY` is reused and never rotated by this deploy script;
- exact five Action operationIds remain unchanged;
- unknown fields still fail closed;
- request and response ceiling remains 90,000 bytes;
- `canonicalDealJson` is bounded to 85,000 characters in OpenAPI and additionally byte-checked in Worker;
- no historical Snapshot is mutated or reused as a Release C acceptance fixture.

## Acceptance gates

`ACTIONS-RC-02_DEPLOY_STAGING_ONLY.sh` must prove:

- exact staging target and source SHA guards;
- full local regression suite when dependencies are available;
- Wrangler staging dry-run;
- existing Bearer key authenticates before deploy; no secret mutation;
- staging deploy only;
- live health reports `actionBridgeVersion=ACTIONS-RC-02` while MCP remains `RC-CORR-06C`;
- unauthenticated Action => HTTP 401;
- authorized `canonicalDealJson:"{}"` validation reaches backend as an object and returns normal Canonical schema issues, not `canonicalDeal must be an object`.

Final success marker:

`RESULT=ACTIONS-RC-02_STAGING_TRANSPORT_PASS`

After that marker, paste the bundled `openapi-actions.yaml` into the existing Custom GPT Action schema and run the real Canonical Deal E2E.
