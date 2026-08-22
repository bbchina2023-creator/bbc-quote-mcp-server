# Custom GPT Actions setup — ACTIONS-RC-02

Keep the existing Authentication setting exactly as-is:

- Type: API Key
- Authentication type: Bearer
- Existing API key: unchanged

Replace only the Action schema with this package's `openapi-actions.yaml`.

## Canonical transport rule

For `validateCanonicalDeal` and `recalculateDeal`, the GPT must pass the complete Canonical Deal JSON text in `canonicalDealJson`.

The Worker parses that string into the object expected by the unchanged deterministic backend. The GPT must not summarize, reconstruct, calculate, or modify the Canonical Deal between validation and recalculation.

The manager workflow remains:

1. Upload current source files directly in the GPT chat.
2. GPT extracts facts and builds Canonical Deal Contract v1.
3. GPT asks only unresolved business-critical questions.
4. GPT calls `validateCanonicalDeal` with the exact serialized Canonical Deal in `canonicalDealJson`.
5. Only if `readyForSnapshot=true`, GPT calls `recalculateDeal` with the exact same `canonicalDealJson` and one stable idempotency key.
6. GPT gets the exact VERIFIED Snapshot v2 by returned `snapshotId`.
7. GPT calls `generateQuote` with that snapshot and one stable generation idempotency key.
8. GPT returns the three actual Google Sheets / XLSX / PDF links.

The GPT must never calculate or override financial totals itself.
