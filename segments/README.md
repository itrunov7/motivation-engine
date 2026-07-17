# /segments — Product segments

## What lives here

- `segments.yaml` — the product-segment axis: a flat, grouped list of the
  product types Ventora builds. Each entry is
  `{ id, group, definition, status, provenance }`.
- `candidates.json` — the owner-approval queue for analyzer-proposed segments
  (D-054): `{ version, generated_at, candidates[] }`, each candidate
  `{ id, group, definition_draft, evidence_note, proposed_at, status }`.
  Generated output for `tools/segment-suggest.ts` (designed, not yet scheduled);
  empty today.

These segments classify the **OUTPUT products** Ventora builds
(transactional storefronts, subscription apps, marketplaces, …), **not
Ventora itself**. They are first-class, evolving system data the rest of
the layer references.

## Groups

- `business-model` — how the product makes money.
- `form` — what surface the product lives on.
- `audience` — who buys/uses it.
- `usage-rhythm` — how often it is used.

## Evolution

The seed set (15 segments) is owner-provided and carries
`provenance: seed-2026-07`. New segments added later carry
`provenance: analyzer` (derived) or `owner` (hand-added). A segment no
longer in use is marked `status: retired` rather than deleted, so history
stays legible. Editing is git-only — no UI write surface.

The axis is a **seed, not a fixed set** (D-054):

- **Owner adds now.** Append an entry with `provenance: owner`. On the next
  analyzer run the segment enters the sufficiency matrix as an honest **all-red**
  column (nothing demonstrated for it yet) and the gap planner queues research
  tasks for it (qualifier derived from its id). The owner graduates it out of
  bootstrap by adding `segment_stages` (and optionally `segment_affinity` /
  `gap_planner.*`) to `analysis/analyzer.config.yaml`.
- **Analyzer suggests later.** `tools/segment-suggest.ts` (designed, not yet
  scheduled) will propose candidates into `candidates.json` from recurring
  product-context clusters in the harvested corpora, for owner approval.

See the "Segment evolution" section of
[`docs/connectors-runbook.md`](../docs/connectors-runbook.md) for the operator
walkthrough.

## Validated by

`tools/validate.ts` (`npm run validate`), run in CI on every push. The
file must parse as YAML, every entry must match the schema, and ids must
be unique.

## Renders

The `/maturation` cockpit (D-053) reads this file: active segments are the
columns of the sufficiency heatmap, and the "Segments are evolving" panel
shows their active/retired counts, provenance, and any awaiting candidates.
Statuses are computed from the matrix, never hardcoded.
