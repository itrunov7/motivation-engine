# /segments — Product segments

## What lives here

- `segments.yaml` — the product-segment axis: a flat, grouped list of the
  product types Ventora builds. Each entry is
  `{ id, group, definition, status, provenance }`.

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

## Validated by

`tools/validate.ts` (`npm run validate`), run in CI on every push. The
file must parse as YAML, every entry must match the schema, and ids must
be unique.

## Renders

Nowhere yet — this is data only. No app screen reads or displays segments
at this step.
