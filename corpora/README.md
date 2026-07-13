# /corpora — Harvested datasets

## What lives here

Datasets harvested from the external sources registered in
`/sources/sources.json`: interface screens and flows (class A), science
papers and effect sizes (class B), benchmarks (class C), and non-obvious
corpora such as earnings calls or enforcement actions (class D).

## Contract

- One subfolder per corpus: `/corpora/{source_id}/` where `source_id`
  matches an `id` in `sources.json`.
- Every corpus subfolder must contain a `manifest.json` describing:
  the source id, harvest date, item count, license/legal note (copied
  from the source's `legal_note`), and the pipeline that produced it.
- Structured rows at scale move to managed Postgres and binary raw data
  to object storage per the escalation triggers in `docs/architecture.md`;
  this folder holds file-sized corpora and manifests only.
- The app computes corpus block statuses from this folder: empty folder →
  `planned`. No status is ever asserted in code.

## Filled by

Future source connectors (per-source, gated by the legal notes in
`sources.json`). Building connectors is explicitly out of scope for
baseline.

## Phase

August–September (connectors phase, roadmap M5).
