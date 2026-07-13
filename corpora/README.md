# /corpora — Harvested datasets

## What lives here

Datasets harvested from the external sources registered in
`/sources/sources.json`: interface screens and flows (class A), science
papers and effect sizes (class B), benchmarks (class C), and non-obvious
corpora such as earnings calls or enforcement actions (class D).

## Contract

- One subfolder per corpus: `/corpora/{source_id}/` where `source_id`
  matches an `id` in `sources.json`. Subfolders prefixed with `_`
  (e.g. `_dummy`, the framework smoke test) are internal and ignored
  by the showcase.
- Every corpus subfolder must contain a `manifest.json` written by the
  connector runner (`npm run connector -- <id>`, D-012) with exactly
  this shape:

```jsonc
{
  "source_id": "openalex",          // = directory name
  "connector_version": "1.0.0",
  "last_run": {
    "timestamp": "2026-07-13T10:00:00.000Z",
    "status": "success",            // success | partial | failed
    "params": { "query": "…" },
    "records_fetched": 120,
    "files_written": 1,
    "duration_s": 4.2,
    "error": "…"                    // only for partial/failed
  },
  "run_history": [ /* last 20 runs, newest first, same shape */ ],
  "data_files": [ { "path": "records.json", "records": 120, "bytes": 48213 } ]
}
```

- The manifest is written on EVERY run outcome, including failures —
  this folder always tells the honest truth about the last run.
- Guardrail: a corpus directory over 40 MB fails the run. That size is
  the "corpora arrive (thousands of rows)" Postgres escalation trigger
  in `docs/architecture.md` — structured rows at scale move to managed
  Postgres and binary raw data to object storage; this folder holds
  file-sized corpora and manifests only.
- The app computes corpus block statuses from this folder: empty folder →
  `planned`. No status is ever asserted in code.
- `npm run validate` checks every `manifest.json` against this contract.

## Filled by

Source connectors under `tools/connectors/` (one per source, gated by
the legal notes in `sources.json`), executed via
`npm run connector -- <id> [key=value ...]`. Connectors may call ONLY
the D-011 whitelisted public APIs.

## Phase

August–September (connectors phase, roadmap M5); the connector
framework itself shipped in Phase 2 (D-012).
