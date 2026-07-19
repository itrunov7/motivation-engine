# /registry/mechanisms/_seed — Candidate seed stubs

## What lives here

Candidate seed mechanism stubs, one JSON file each, in the reduced shape:

```json
{ "id": "…", "name": "…", "grade_draft": "…", "oneliner": "…", "parent": "…", "lifecycle_status": "candidate" }
```

A stub may also carry owner-provided `evidence_terms` and `pinned_evidence`
(so a candidate can be harvested before it is fleshed out) and, under a
cross-cutting L0 node, `cross_cutting: true` (D-062).

The original SPEC.md §2 seed roster (VR-02, EN-03, HA-04, CG-05, SC-06, ZE-07,
SP-08, ST-09, RE-10, FR-11, ID-12; LA-01 was always full) has since been
promoted to full records one level up. The current roster here is the S7
Perception & comprehension candidates (D-063): PS-13, CL-14, MM-15, PF-16,
SC-17, IF-18.

Stubs stay stubs — they are not fleshed out until a dossier moves them
through the lifecycle gate. Validated against a separate lax sub-schema.

## Filled by

Owner-provided roster, entered during the data step. Content of mechanisms
is never invented by tooling or AI.

## Phase

July (baseline).
