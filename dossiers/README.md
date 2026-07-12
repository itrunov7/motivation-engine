# /dossiers — Admission gate records

## What lives here

- `dossier.schema.json` — schema for dossier records.
- One JSON dossier per lifecycle decision, shaped as:
  `{ id, mechanism_id, scores{…}, total, evidence_sources[], verdict, decided_by, date, notes }`.

A dossier scores a mechanism on five axes (0–3 each): `evidence`,
`product_applicability`, `measurability`, `orthogonality`, `safety`.
Thresholds: *incubating* requires total ≥ 11 AND evidence ≥ 2 AND safety ≥ 2;
*core* additionally requires at least one measured effect.

Dossiers are the only way a mechanism moves through the lifecycle
(candidate → incubating → core). The showcase displays statuses; it never
changes them.

## Filled by

Owner decisions, entered in git. The schema ships with the baseline; the
folder stays empty of dossiers until the first one (LA-01) — the app shows
an honest empty state until then.

## Phase

Schema: July (baseline). First dossier (LA-01): next milestone after baseline.
