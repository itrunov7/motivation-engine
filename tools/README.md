# /tools — Repo tooling

## What lives here

- `validate.ts` — validates every file in `/registry/mechanisms` (full schema
  or `_seed/` lax sub-schema), `taxonomy.json`, `sources.json`,
  `decisions.json`, dossier schema integrity, and every
  `/corpora/*/manifest.json` against the connector manifest contract.
  Non-zero exit on any violation. Exposed as `npm run validate` and run
  in CI on every push.
- `render-cards.ts` — renders each full mechanism JSON into `/cards/{id}.md`.
  Exposed as `npm run cards`.
- `run-connector.ts` — CLI runner for source connectors:
  `npm run connector -- <id> [key=value ...]`. Looks the connector up in
  `connectors/index.ts`, executes it, enforces the 40 MB corpus guardrail,
  and writes `/corpora/{source_id}/manifest.json` on every outcome
  (non-zero exit on failure). See D-012.
- `connectors/` — the connector framework: `types.ts` (Connector interface +
  manifest contract), `lib/http.ts` (rate-limited fetch, 3 retries with
  exponential backoff, polite headers, D-011 whitelist enforcement),
  `lib/io.ts` (pretty JSON writer, corpus size guardrail), `lib/manifest.ts`
  (manifest merge/write), `dummy.ts` (smoke-test connector writing to
  `/corpora/_dummy/`; `fail=1` simulates a failure), `evidence.ts`
  (OpenAlex + Semantic Scholar literature harvester, D-014/D-015/D-017).

## Connector environment variables

- `CONNECTOR_MAILTO` — contact email for polite headers and the OpenAlex
  `mailto` param; can also be passed per run as `mailto=me@example.com`.
- `S2_API_KEY` — optional Semantic Scholar API key (D-018), sent as the
  `x-api-key` header. Authenticated clients get materially higher rate
  limits. Without it the evidence connector runs against the shared keyless
  pool: on the first HTTP 429 it degrades gracefully — per-term batch drops
  from 15 to 10 for the retry passes (exponential cooldowns 30s/60s/120s)
  and the manifest records `warnings: { "s2_throttled": true }` instead of
  the run failing. In CI the key comes from the `S2_API_KEY` repository
  secret (see `.github/workflows/validate.yml`); locally, export it in your
  shell or put it in `.env.local` (never commit it).

## Filled by

Built in the tooling step of the baseline, together with
`.github/workflows/validate.yml`; the connector framework was added in
Phase 2 (D-012).

## Phase

July (baseline); connector framework July (Phase 2).
