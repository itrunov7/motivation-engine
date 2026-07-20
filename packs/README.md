# /packs — Pack map + generated packs

## What lives here

- `pack-map.yaml` — the **one hand-authored input** to pack generation: which
  mechanisms' evidence is relevant to which Development-Plan element type. Each
  entry is `{ id, applies_to, funnel_stage, mechanisms, note? }`.
- `pack-{id}.yaml` — **generated** datasheets, one per pack-map element
  (`npm run packs`, D-049). These are computed projections over the pack map +
  the registry; **never edit them by hand** — change a registry record (or the
  map) and re-render. Stale packs are removed automatically on regenerate.
- `export/packs-bundle.yaml` — **generated** export artifact for team testing
  (D-068): a multi-document YAML stream — a manifest (pack count, pack-map
  version, pack ids) followed by every `pack-{id}.yaml` verbatim. Rebuilt from
  the packs on disk by every `npm run packs` run (full or scoped), carries no
  timestamp (pure function of the packs — it only diffs when a pack diffs).
  The team consumes it directly from git; never edit it by hand.

## Why this is the only judgment call

Mapping mechanisms to product elements is the sole human decision in the pack
pipeline. Everything downstream — the packs themselves — is a **computed
projection** over this map plus the registry. Packs are never hand-authored;
this file is.

## Fields

- `id` — the Development-Plan element type (unique slug), e.g. `paywall-conversion`.
- `applies_to` — the product surfaces the element covers (free-text slugs),
  e.g. `[paywall, pricing]`.
- `funnel_stage` — where the element sits in the funnel, from the registry
  vocabulary: `cold_acquisition | onboarding | activation | conversion |
  retention | reactivation`.
- `mechanisms` — the mechanism ids whose evidence is relevant to the element.
  Every id must resolve to a record in `/registry/mechanisms/`.
- `note` — optional owner annotation (e.g. `guardrail-forward`).

`funnel_stage` records evidence **relevance**, not runtime applicability — an
element's stage may differ from a member mechanism's `applicability`
(e.g. `entry` is `cold_acquisition` while `SP-08`/`FR-11` exclude that stage at
generation time). The validator deliberately does not cross-check the two.

## Evolution

The seed map (11 element types) is owner-provided. Editing is git-only — no UI
write surface.

## Validated by

`tools/validate.ts` (`npm run validate`), run in CI on every push. The file
must parse as YAML, every entry must match the schema, element ids must be
unique, and every referenced mechanism id must resolve to a registry record.
The export bundle, when present, must parse as multi-document YAML and its
manifest must exactly match the pack files on disk (D-068) — a mismatch means
a stale or hand-edited bundle.

## Renders

The pack datasheets render nowhere yet — they are data only. The `/maturation`
cockpit shows the export bundle's manifest (pack count, version, handoff path)
read from `export/packs-bundle.yaml` at render time (D-068); no app screen
displays the pack map or datasheet contents at this step.
