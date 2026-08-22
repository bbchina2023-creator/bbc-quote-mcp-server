# RC-CORR-06C — ChatGPT Business tool metadata correction

## Confirmed failure before this candidate
RC-CORR-06A returned `initialize=200` and `tools/list=200` with the exact five tools, yet ChatGPT Business saved the draft with `0 actions`.

The project is pinned to `@modelcontextprotocol/sdk` v1.29.0. That SDK serializes tool authentication metadata only inside `_meta`; it does not emit a first-class `securitySchemes` property on each tool in `tools/list`. Current OpenAI Apps SDK authentication guidance requires tool-level `securitySchemes` and recommends mirroring it in `_meta` for compatibility.

## RC-CORR-06C change
- Keep anonymous `initialize` and `tools/list` for discovery.
- Promote each tool's OAuth scheme to root-level `securitySchemes` in the wire `tools/list` response.
- Preserve `_meta.securitySchemes` as the compatibility mirror.
- Keep exact scope mapping:
  - validateCanonicalDeal -> quote.read
  - recalculateDeal -> quote.write
  - getVerifiedSnapshot -> quote.read
  - generateQuote -> quote.generate
  - getDealStatus -> quote.read
- Keep backend execution fail-closed when the required scope is absent.
- Return the documented in-band `_meta["mcp/www_authenticate"]` challenge with `error` and `error_description` for unauthenticated/insufficient-scope tool calls.
- Apps Script and production remain unchanged.

## Required live gate before another ChatGPT draft
The deploy script must finish with:

`RESULT=RC-CORR-06C_STAGING_DEPLOYED_AND_CHATGPT_TOOL_METADATA_GATE_PASS`

It verifies:
1. exact staging target;
2. source SHA;
3. pinned dependency install;
4. targeted tests;
5. Wrangler dry-run;
6. staging-only deploy;
7. live release identity;
8. anonymous `initialize` + exact five `tools/list` entries + root and `_meta` securitySchemes;
9. unauthenticated protected tool call returns in-band OAuth challenge and never reaches backend.

## ChatGPT creation after PASS
Use the normal OAuth creation flow, not No Auth:
- Authentication: OAuth
- Registration: DCR
- scopes: quote.read, quote.write, quote.generate
- endpoint: https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev/mcp

Do not publish until the draft displays exactly five actions.
