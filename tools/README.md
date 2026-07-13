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
- `health-check.ts` — source health heartbeat (D-021): one minimal
  single-record request per probeable api source (D-011 whitelist only,
  one attempt, no retries — retries would mask "degraded"), writing
  `/corpora/_health/heartbeat.json`. Statuses: `ok` (2xx), `degraded`
  (HTTP 429/206 — the s2_throttled condition), `down` (network error /
  timeout / 5xx), `unknown` (no probe — host not whitelisted), `n_a`
  (internal source, no external endpoint by design). The file is rewritten
  only when statuses changed or the committed heartbeat is older than 11h,
  so the scheduled workflow (`.github/workflows/connectors.yml`, every 6h +
  `workflow_dispatch`) commits at most ~2/day on quiet days. Exposed as
  `npm run health`. A `down` source exits 0 — it is a recorded fact, not a
  script failure.

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

## Health × connection runbook (D-021)

Connection (from corpus manifests: has a harvest run ever succeeded) and
health (from the heartbeat: is the API answering right now) are independent
axes. Read them together:

| connection    | health     | reading and action                                                                 |
| ------------- | ---------- | ---------------------------------------------------------------------------------- |
| connected     | ok         | all good — nothing to do                                                            |
| connected     | down       | transient API outage — wait and retry later; the corpus itself is fine              |
| connected     | degraded   | throttled (429/206) — check rate limits and keys (e.g. set `S2_API_KEY`, D-018)     |
| not_connected | ok         | the API is fine but no successful harvest run exists — run the connector            |
| not_connected | down       | cannot harvest right now anyway — wait for health to recover, then run the connector |
| any           | unknown    | heartbeat stale (>12h) or no probe exists — run `npm run health`, or build the source's connector first (the D-011 whitelist grows with connectors, not ahead of them) |
| any           | n/a        | internal source — no external endpoint by design; nothing to probe                  |

## Operations — watch issues, not logs (D-022)

The operator's contract is **watch the issue tracker, not the Actions logs**.
Nobody is expected to read run logs proactively; a green issue tracker means
healthy operations.

- `.github/workflows/connectors.yml` runs on a schedule. A failing run is
  **retried once after a 60s backoff**. If it still fails, the workflow
  **opens a GitHub issue** titled `connector:{id} failing`, labeled `ops`,
  with the captured error output. The `ops` label is created if missing, and
  the run is failed (red) after the issue is filed.
- **Deduplication**: while an open `ops` issue with that exact title exists,
  no second issue is opened — one failing connector is one issue. Fix the
  cause, then **close the issue** to re-arm the automation for that connector;
  the next failure opens a fresh one.
- The automation is written generically around `CONNECTOR_ID` (today the
  health heartbeat, id `health`), so a future scheduled harvest job reuses it
  verbatim — its issue body would carry the manifest's `last_run.error`.
- **Cost**: every connector run records a `cost` block in its manifest
  (`api_calls`, `duration_s`, reserved `tokens_in`/`tokens_out`,
  `estimated_usd`). The `/connectors` cockpit shows a **monthly rollup** per
  connector and a total (runs, api_calls, duration, estimated_usd) computed
  from `run_history`. `estimated_usd` reads $0.00 while every source is a free
  D-011 public API; it goes non-zero when a priced job reports token usage.
- Health vs. connection matrix (which issue means what) lives with the Source
  health section on `/connectors` and in `corpora/README.md`.

## Filled by

Built in the tooling step of the baseline, together with
`.github/workflows/validate.yml`; the connector framework was added in
Phase 2 (D-012). Cost accounting and failure automation added in D-022.

## Phase

July (baseline); connector framework July (Phase 2).
