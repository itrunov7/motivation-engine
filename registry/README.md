# /registry — The ontology registry

## What lives here

- `taxonomy.json` — the fixed L0 taxonomy (8 systems, S1–S8; S7
  Perception & comprehension is cross-cutting, D-062; S8 Interaction &
  agency is pack-scoped, D-084).
- `mechanism.schema.json` — JSON Schema for full L1 mechanism records.
  Hard rules: `implementations[].metrics` and `constraints.hard_rules`
  must be non-empty, otherwise the record is invalid.
- `mechanisms/` — full L1 mechanism records, one JSON file per mechanism
  (baseline: LA-01 Loss aversion, the reference record).
- `mechanisms/_seed/` — candidate seed stubs (currently the 8 owner-authored
  S8 candidates), using the separate reduced sub-schema.

This folder is the source of truth for the ontology. Data is edited in git
only — no UI editing, no database.

## Filled by

Owner-provided content (LA-01 from `content-inbox/LA-01.json`, seed roster
from SPEC.md §2) during the data step. Validated by `tools/validate.ts`
(`npm run validate`).

## Phase

July (baseline).
