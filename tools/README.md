# /tools — Repo tooling

## What lives here

- `validate.ts` — validates every file in `/registry/mechanisms` (full schema
  or `_seed/` lax sub-schema), `taxonomy.json`, `sources.json`,
  `decisions.json`, and dossier schema integrity. Non-zero exit on any
  violation. Exposed as `npm run validate` and run in CI on every push.
- `render-cards.ts` — renders each full mechanism JSON into `/cards/{id}.md`.
  Exposed as `npm run cards`.

## Filled by

Built in the tooling step of the baseline, together with
`.github/workflows/validate.yml`.

## Phase

July (baseline).
