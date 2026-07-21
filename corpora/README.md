# /corpora — Harvested datasets

## What lives here

Datasets harvested from the external sources registered in
`/sources/sources.json`: interface screens and flows (class A), science
papers and effect sizes (class B), benchmarks (class C), and non-obvious
corpora such as earnings calls or enforcement actions (class D).

## Contract

- One subfolder per corpus: `/corpora/{corpus}/` named after the
  connector's `sourceId` (its corpus id). A connector is not a source
  (D-014): the manifest declares the `sources.json` ids it harvests in
  `source_ids[]`, so one corpus may serve several sources (e.g.
  `evidence` harvests both `openalex` and `semantic-scholar`).
  Subfolders prefixed with `_` (e.g. `_dummy`, the framework smoke
  test) are internal and ignored by the showcase.
- Every corpus subfolder must contain a `manifest.json` written by the
  connector runner (`npm run connector -- <id>`, D-012) with exactly
  this shape:

```jsonc
{
  "source_id": "evidence",          // corpus id = directory name
  "source_ids": ["openalex", "semantic-scholar"],  // sources.json ids harvested (D-014)
  "connector_version": "1.0.0",
  "last_run": {
    "timestamp": "2026-07-13T10:00:00.000Z",
    "status": "success",            // success | partial | failed
    "params": { "query": "…" },
    "records_fetched": 120,
    "files_written": 1,
    "duration_s": 4.2,
    "error": "…",                   // only for partial/failed
    "warnings": { "s2_throttled": true },  // optional degradation flags (D-018)
    "cost": {                       // cost accounting (D-022)
      "api_calls": 37,              // outbound HTTP requests, retries included
      "duration_s": 4.2,            // mirrors last_run.duration_s
      "tokens_in": null,            // reserved for future LLM jobs
      "tokens_out": null,           // reserved for future LLM jobs
      "estimated_usd": 0            // computed; 0 for the free D-011 APIs
    }
  },
  "run_history": [ /* last 20 runs, newest first, same shape */ ],
  "data_files": [ { "path": "records.json", "records": 120, "bytes": 48213 } ]
}
```

- The manifest is written on EVERY run outcome, including failures —
  this folder always tells the honest truth about the last run.
- `cost` (D-022) is optional on a run because runs recorded before D-022
  carry no block; the runner always writes it going forward. `api_calls`
  is counted at the polite-fetch layer (retries included), `tokens_in` /
  `tokens_out` are reserved for future LLM jobs (null until an engine
  exists), and `estimated_usd` is computed — 0 for the free D-011 public
  APIs, never a hardcoded status. The `/connectors` cockpit rolls these up
  per connector for the current calendar month.
- Guardrail: a corpus directory over 40 MB fails the run. That size is
  the "corpora arrive (thousands of rows)" Postgres escalation trigger
  in `docs/architecture.md` — structured rows at scale move to managed
  Postgres and binary raw data to object storage; this folder holds
  file-sized corpora and manifests only.
- The app computes corpus block statuses from this folder: empty folder →
  `planned`. Source connection is computed from `source_ids`: a source is
  connected iff ANY manifest here lists it in `source_ids` (D-014, D-026) —
  connection means "the connector is set up and has run", while run quality
  (success / partial / failed from the newest `last_run`) is shown as its
  own axis. No status is ever asserted in code.
- `npm run validate` checks every `manifest.json` against this contract:
  every `source_ids` entry must exist in `sources.json`, and a
  non-internal corpus must harvest at least one source.

### Realization corpus (`realizations/`, D-081)

Interface evidence is stored separately from literature at
`/corpora/realizations/{mechanism_id}/records.json`. A record contains bounded
quotable text, a source locator, artifact context, and either `origin:
"harvested"` or `origin: "owner"`. Harvested records may use only legally
permitted public sources such as Wayback. Owner records may name a
`connection_mode: "manual"` source, but neither the app nor tools may fetch
that source. Screenshots, video, and raw HTML are never stored here.

## Ops config (`_ops/`, D-024)

`/corpora/_ops/` is not a corpus — it holds the fleet's operating
parameters as versioned data: `budget.json` (monthly caps) and
`connectors/{id}.json` (per-connector limits, pause, cadence, targets).
The full contract lives in `_ops/README.md` and `lib/ops.ts`; `npm run
validate` checks every `_ops` file with the same validators the write
path uses, so a malformed config fails CI rather than silently
misconfiguring the fleet.

The runner additionally enforces `limits.max_calls_per_run` at the
polite-fetch layer DURING the run, retries included (D-027) — a
connector cannot opt out. For connectors that call Semantic Scholar the
limit is sized so a run stays within minutes even if every call were S2
at its 1 request/second cumulative key allowance (100 S2 calls ≈ 2 min;
the evidence connector's default is 150).

## Health heartbeat (`_health/heartbeat.json`, D-021)

`/corpora/_health/` is not a corpus — it holds the source health heartbeat
written by `tools/health-check.ts` (scheduled every 6 hours by
`.github/workflows/connectors.yml`, plus `workflow_dispatch`; also
`npm run health`). Health is a separate axis from connection: connection
says "has a harvest run ever succeeded", health says "is the API answering
right now". The app reads this file only — it never calls external APIs.

```jsonc
{
  "generated_at": "2026-07-13T18:00:00.000Z",
  "entries": [
    {
      "source_id": "openalex",            // sources.json id
      "checked_at": "2026-07-13T18:00:00.000Z",
      "status": "ok",                     // ok | degraded | down | unknown | n_a
      "latency_ms": 412,                  // null when no request was made
      "note": "GET /works search=motivation per-page=1 — HTTP 200"
    }
  ]
}
```

- `ok` = 2xx · `degraded` = throttled (HTTP 429/206, the s2_throttled
  condition) · `down` = network error / timeout / 5xx · `unknown` = no
  probe (host not in the D-011 whitelist) · `n_a` = internal source, no
  external endpoint by design.
- The file is rewritten only when statuses changed or the committed
  heartbeat is older than 11h (commit-noise rule); the UI treats a
  heartbeat older than 12h as `unknown` — stale never renders as ok.
- `npm run validate` checks the heartbeat against its contract when
  present; every `source_id` must exist in `sources.json`.

## Filled by

Source connectors under `tools/connectors/` (each harvesting one or
more sources, gated by the legal notes in `sources.json`), executed via
`npm run connector -- <id> [key=value ...]`. Connectors may call ONLY
the D-011 whitelisted public APIs.

## Phase

August–September (connectors phase, roadmap M5); the connector
framework itself shipped in Phase 2 (D-012).
