# S7 drafting brief — turning six candidates into records + dossiers

This is the hand-off contract for **Step 4** of the S7 Perception & comprehension
phase: the six candidate stubs become full L1 records with grades, boundaries,
realizations and hard rules — or are rejected. Claude drafts the records and the
five-axis dossiers from the harvested corpora; the owner (Igor) reviews; Cursor
commits verbatim.

The division of labour is fixed by `.cursorrules` rule 8: **Cursor writes code,
schemas, UI — never science.** The content of every mechanism (evidence grades,
scientific claims, dissent, dossier prose) is authored by the owner or Claude and
entered verbatim. This document tells the author exactly what shape to fill and
which hard rules the validator will enforce, so the first draft passes
`npm run validate` on the first try.

---

## 1. The six candidates (roster)

Source: `registry/mechanisms/_seed/{id}.json` (D-063). All six carry
`cross_cutting: true` — S7 is a cross-cutting L0 node (D-062): these mechanisms
apply to *every* generated element, not to specific funnel stages.

| ID | Name | grade_draft | oneliner |
|----|------|-------------|----------|
| PS-13 | Picture superiority / dual coding | A | Images are processed and remembered better than equivalent words; verbal and visual channels are distinct (dual coding). |
| CL-14 | Cognitive load | A | Working memory is narrow; extraneous load degrades comprehension and action. |
| MM-15 | Multimedia design principles | A | How text and images are combined determines comprehension: coherence, signalling, redundancy, contiguity. |
| PF-16 | Processing fluency | A- | Easily processed information is judged more likeable, more true and less risky. |
| SC-17 | Scanning & visual attention | B | People scan interfaces in patterns rather than reading linearly; attention is selective and skips ad-like elements. |
| IF-18 | Information foraging | B+ | Users follow information scent, sampling cues to judge whether a path is worth pursuing, rather than reading exhaustively. |

`grade_draft` on the stub is a *draft* hint. The full record's `evidence.grade`
is the author's committed grade (strict enum `A+…C-`) and may differ once the
corpus is read. A candidate may also be **rejected** — that is a legitimate,
expected outcome of this step, recorded on the dossier (`verdict: "rejected"`).

---

## 2. Inputs

For each candidate, draft from the **digest**, not the raw corpus:

- Digest (primary input): `corpora/evidence/digests/{id}.md`
  — top records per evidence category (foundational / meta-analysis /
  replication / dissent / recent), plus corpus stats, pins resolved/unresolved,
  coverage and diversity. Produced by `npm run digest -- {id}` (see
  `tools/corpus-digest.ts`). This is the standard harvest → drafting hand-off
  format for all future batches (D-065); the raw corpus JSON stays on disk as
  provenance but is no longer read by hand.
- Exemplars (copy the shape, not the content):
  - Full record: `registry/mechanisms/LA-01.json`
  - Dossier: `dossiers/LA-01.json`
- Schemas (the authority on required fields):
  - `registry/mechanism.schema.json`
  - `dossiers/dossier.schema.json`

The digest carries real dissent counts per mechanism (PS-13, CL-14, MM-15,
PF-16, SC-17, IF-18 all harvested with a non-empty `dissent` category). Use it —
a dossier that can only confirm is broken (D-019).

---

## 3. Full record shape (field-by-field)

Every field below is required by `registry/mechanism.schema.json` unless marked
optional. Full JSON authority: the schema; the map below translates the Step 4
vocabulary ("realizations", "grades", "boundaries") into the actual field names.

| Step-4 term | Record field |
|-------------|--------------|
| grade | `evidence.grade` (strict `A+…C-`) |
| realizations | `implementations[]` |
| boundaries | `evidence.caveats` + `constraints.boundary_test` + `applicability.preconditions` |
| hard rules | `constraints.hard_rules[]` |
| dissent | lives on the **dossier**, not the record |

Required top-level fields:

- `$schema`: `"../mechanism.schema.json"`
- `id`: the candidate id, e.g. `"PS-13"`
- `slug`: lowercase `[a-z0-9_]+`, e.g. `"picture_superiority"`
- `name`: from the roster
- `version`: `"1.0.0"` for a first full record
- `level`: `"L1"`
- `parent`: `"S7"` (now permitted — full-record parent widened to `^S[1-7]$`, D-064)
- `cross_cutting`: `true` (all six)
- `lifecycle_status`: `"incubating"` if admitted, `"rejected"` if not
- `dossier_ref`: `"dossiers/{id}.json"` (setting this **requires** a non-empty
  `evidence_terms` — D-038)
- `provenance`: `{ "proposed_by": "owner", "date": "YYYY-MM-DD" }`
- `evidence`: `{ grade, basis, effect_size_note, caveats[] }` — all required
- `evidence_terms[]`: carry over/refine the stub's terms; must include
  disconfirming / boundary terms, not only confirming ones
- `pinned_evidence[]`: optional; carry over the stub's pins
- `orthogonality_note`: optional; use when a mechanism overlaps a neighbour
  (e.g. MM-15 vs CL-14, PF-16 vs PS-13) to explain the managed overlap
- `prior_weight`: 0–1
- `mechanism_summary_for_context`: the text future generation will consume —
  concrete, operational, no citations
- `applicability`: `{ funnel_stages[], excluded_stages[], artifact_types[],
  preconditions[], culture_note }` — all required. Because S7 is cross-cutting,
  `funnel_stages` and `artifact_types` will typically be broad.
- `implementations[]`: at least one; see below
- `constraints`: `{ hard_rules[], compliance_refs[], boundary_test }` — all required
- `relations[]`: typed links to other records (`enabled_by`, `enables`,
  `adjacent`, `hybrid_with`, `orthogonality_note`); target must be an existing id
- `telemetry`: `{ tag_format, amplitude_event_property }`
- `reference_examples[]`: optional but recommended (`{ product, what }`)

### Hard rules the validator enforces (record is INVALID otherwise)

1. Every `implementations[].metrics` array is **non-empty**.
2. `constraints.hard_rules` is **non-empty**; each rule is
   `{ id, rule, severity: "block" | "warn" }`.
3. If `dossier_ref` is non-null, `evidence_terms` is **non-empty** (D-038).
4. `id` must equal the filename stem; ids unique across the registry;
   `parent` must exist in the taxonomy (S7 does).

### Realizations (implementations) — expected shape vocabulary

These are evidence-base terms describing the *kind* of realization to look for,
not instructions to invent. Draw the actual directives from the corpus:

- image-over-text substitution (PS-13)
- progressive disclosure (CL-14)
- chunking (CL-14)
- signalling / emphasis (MM-15)
- redundancy avoidance (MM-15)
- scan-friendly hierarchy (SC-17)
- scent-carrying labels (IF-18)

Each `implementations[]` entry needs: `id`, `artifact_types[]` (≥1),
`product_requirements[]`, `generation_directive`, `copy_formulas[]`,
`metrics[]` (≥1, Amplitude-reachable), `observed_effects[]` (usually `[]` at
first — no measured effect yet).

---

## 4. Dossier shape (`dossiers/{id}.json`)

Authority: `dossiers/dossier.schema.json`. Naming: file `dossiers/{id}.json`,
record `id` `"DOS-{id}"`, `mechanism_id` `"{id}"`.

Required fields: `id`, `mechanism_id`, `scores`, `total`, `core_condition`,
`dissent`, `evidence_sources[]`, `verdict`, `decided_by`, `date`, `notes`.

Five scoring axes, each `{ score: 0–3, rationale: markdown }`:

- `evidence`
- `product_applicability`
- `measurability`
- `orthogonality`
- `safety`

`total` **must equal the sum** of the five axis scores (validator checks this).

`dissent` is a required markdown statement of real counter-evidence (D-019).
Expected dissent themes to mine from each corpus:

- PS-13 — picture-superiority **boundary conditions** (when text wins: precise
  quantities, abstract relations, comparison tasks; concreteness confounds).
- PF-16 — **fluency-effect critiques** (fluency as a fragile/overclaimed cue;
  disfluency-aids-memory findings; replication concerns).
- SC-17 — the **practitioner-vs-experiment gap** in scanning research (heavily
  cited industry eye-tracking work vs. peer-reviewed experimental controls).
- CL-14, MM-15, IF-18 — surface the strongest counter-evidence the corpus
  carries (e.g. cognitive-load measurement validity debates; redundancy-effect
  limits; information-foraging model scope).

### Gate thresholds (owner + validator)

- **Incubating** requires: `total >= 11` AND `scores.evidence.score >= 2` AND
  `scores.safety.score >= 2`.
- **Core** additionally requires at least one measured effect, stated in
  `core_condition`.
- Below the incubating threshold → `verdict: "rejected"` (or `"hold"`), and the
  mechanism record's `lifecycle_status` is `"rejected"`, `dossier_ref` still
  points at the dossier that documents the rejection.

---

## 5. Workflow

1. Cursor runs `npm run digest -- <id>` for each candidate (or `--all`); the six
   digests land in `corpora/evidence/digests/`.
2. Claude drafts each `registry/mechanisms/{id}.json` + `dossiers/{id}.json` from
   the digest + exemplars.
3. Owner reviews the drafts for scientific accuracy.
4. Cursor commits the approved JSON **verbatim**, deletes the corresponding
   `registry/mechanisms/_seed/{id}.json`, and runs `npm run validate` +
   `npm run build`.
5. A `decisions.json` entry records the admission/rejection outcome for the
   batch.

### Definition of done for Step 4

- All six validate (`npm run validate` green).
- Each dossier carries real dissent.
- Registry shows S7 populated with full records (no longer 6 stubs / 0 full).
- Dossiers count rises from 12 to 18.
