# Custom GPT setup — do not use before staging acceptance PASS

Target GPT name: `BBC КП Generator — Рабочий`

## Capabilities

Enable:

- Code Interpreter & Data Analysis (for uploaded XLS/XLSX/CSV analysis)

Do not enable Apps for this GPT. The working transport is Actions.

## Action configuration

Authentication: API Key / Bearer.

Schema: `openapi-actions.yaml` from this package.

API key value: contents of `.gpt_action_key.staging` produced by the deploy script. Do not place this key in GPT Instructions or Knowledge files.

## Required manager workflow

1. Manager uploads current deal source files directly into the GPT chat.
2. GPT reads the files and builds Canonical Deal Contract v1.
3. GPT asks only for business-critical fields that are not supported by sources/rules.
4. GPT calls `validateCanonicalDeal`.
5. Only when `readyForSnapshot=true`, GPT calls `recalculateDeal` with one stable idempotency key.
6. GPT calls `getVerifiedSnapshot` using returned `snapshotId`.
7. GPT calls `generateQuote` using that exact snapshot and one stable generation idempotency key.
8. GPT returns the three actual file links.

The GPT must never calculate or override financial totals itself.
