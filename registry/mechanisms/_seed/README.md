# /registry/mechanisms/_seed — Candidate seed stubs

## What lives here

Candidate seed mechanism stubs, one JSON file each, in the reduced shape:

```json
{ "id": "…", "name": "…", "grade_draft": "…", "oneliner": "…", "parent": "…", "lifecycle_status": "candidate" }
```

A stub may also carry owner-provided `evidence_terms` and `pinned_evidence`
(so a candidate can be harvested before it is fleshed out) and, under a
cross-cutting L0 node, `cross_cutting: true` (D-062).

The original mechanism rosters have been promoted to full records one level
up. The current roster is the owner-authored S8 Interaction & agency set
(D-084): CO-19, AU-20, FB-21, ER-22, DE-23, FL-24, RR-25, AE-26.

Pack-map may declare these candidates as dependencies. The analyzer then marks
those cells red with an explicit candidate-pendency trace and the gap planner
may harvest their owner-provided evidence terms. Generated pack guidance omits
candidate members completely until promotion.

Stubs stay stubs — they are not fleshed out until a dossier moves them
through the lifecycle gate. Validated against a separate lax sub-schema.

## Filled by

Owner-provided roster, entered during the data step. Content of mechanisms
is never invented by tooling or AI.

## Phase

July (baseline).
