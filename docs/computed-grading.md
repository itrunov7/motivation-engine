# Computed grading — a proposal, not a decision

**Status: PROPOSED. Nothing in this document is implemented, and no record is
re-graded until the owner approves it.** Written to answer the grade-provenance
question recorded in D-114.

## 1. Where a grade comes from today

Nothing computes it. The whole specification of an effect grade is one
parenthetical in the extraction prompt:

```
Fields: id, name, fact, boundary, grade (A+..C-), confidence
```

`tools/extract.ts` `taskInstruction`, mode `effects`. The model returns a
letter, `toProposal` copies it through, and the only check is enum membership
via `evidenceGrade(item.grade)`. The synthesis pass adds `grade conservatively`,
which is an adjective and not a criterion.

The two neighbouring fields are no better:

| Field | Authored by | Checked against |
|---|---|---|
| `grade` | model assertion | the nine-value enum, nothing else |
| `boundary` | model assertion | nothing — `item.boundary.trim()` |
| `confidence` | model assertion | `limits.confidence_floor`, currently 0.5 |

No rubric exists anywhere else either. `effects/effect.schema.json` and
`registry/mechanism.schema.json` define `grade` as a bare enum;
`docs/s7-drafting-brief.md` calls it "the author's committed grade", a
human-judgement contract that the pipeline inherited silently when the model
became the author.

The letter does not stay a letter. `PRIOR_WEIGHT_BY_GRADE` in `tools/extract.ts`
converts it into a numeric `prior_weight` on the mechanism record, so a model's
assertion becomes a weight a generator reads as data.

### What that produced

- `cl-14-002` was proposed at `A-` from one narrative review. Corrected to `C+`
  by owner edit before approval, with the basis stated in `grade_basis`.
- `cl14-modality` is proposed at `B+`. Its single cited paper found the
  *opposite* of its `fact`: the abstract's `RESULTS:` reports that spoken text
  produced lower retention and transfer, and `CONCLUSIONS:` names it "a reverse
  modality effect". The quoted span sits in `BACKGROUND:`, where the paper is
  restating prior literature it went on to contradict.

The second case is the important one. No amount of conservatism in a prompt
catches it, because the model was not being incautious — it was quoting the
paper accurately, from the wrong part of the paper.

## 2. What a computed grade would rest on

The corpus already stores enough to compute one. Per
`EvidenceCorpusRecord`: `year`, `citations`, `openalex_type`,
`referenced_works_count`, and a `categories` checklist drawn from
`foundational`, `meta-analysis`, `replication`, `dissent`, `recent`.

The division of labour inverts. The model stops emitting a letter and emits
only things that can be checked against a source:

- `study_design` per cited record, from a closed vocabulary
  (`meta_analysis` | `rct` | `quasi_experiment` | `observational` |
  `narrative_review` | `theoretical`).
- `abstract_section` per citation — which part of the source the quote came
  from (`background` | `aims` | `method` | `results` | `conclusions`).
- `direction` — whether the cited record supports, contradicts, or is neutral
  toward the proposed `fact`.

Code then computes the grade from countable facts: how many *independent* DOIs
back the fact, the strongest design among them, whether the cited records agree
with each other, and how many are tagged `replication` or `dissent`.

## 3. The two gates that matter more than the letter

A rubric that only picks a letter would still have approved `cl14-modality` at
some lower grade. Two hard rules, not a scale:

**Contradiction is a refusal, not a downgrade.** If a cited record's own
`RESULTS:` or `CONCLUSIONS:` contradicts the proposed `fact`, the candidate is
dropped. An effect whose only source refutes it is not weak evidence; it is
evidence against, and grading it `C` would file a false claim in the registry
with a humble-looking label.

**A background quote cannot ground a finding.** A citation whose
`abstract_section` is `background` may support what the *literature* says, never
what the *study found*. Either the effect is restated as a claim about the
field, or the extractor finds a `results`-section span, or the candidate is
dropped. This is the check that would have caught both modality proposals at
extraction time.

## 4. Sketch of the scale

Illustrative, and the part most in need of the owner's judgement:

| Grade band | Requires |
|---|---|
| A band | a meta-analysis, or three or more independent DOIs with consistent direction and at least one replication |
| B band | two or more independent DOIs with consistent direction, strongest design at least quasi-experimental |
| C band | one DOI, or several that disagree, or a narrative-review-only basis |

A single-record basis is capped below the A band unconditionally. `cl-14-002`
lands at `C+` under this rule, matching the owner's manual correction — which is
the only evidence so far that the scale is calibrated at all.

## 5. Consequences to accept before implementing

- **`categories` is sparse.** All three records cited by the CL-14 proposals
  carry an empty `categories` array, while the corpus as a whole reports 12
  meta-analyses and 91 replications. The classifier does not tag the records
  that actually get cited, so a rubric leaning on `categories` would grade most
  effects as if the corpus were thinner than it is. Either the classifier is
  fixed first, or the rubric reads `study_design` from the model and treats
  `categories` as corroboration only.
- **Grades will fall.** Every existing effect proposal was graded by assertion,
  and the one corrected by hand dropped three steps. Approving this rubric means
  accepting a registry that looks weaker, because it was always this weak.
- **`grade_basis` becomes required** on `effects/effect.schema.json`, computed
  rather than written: which DOIs, which designs, which rule set the band.
- **`confidence` needs a definition or removal.** Effects mode never tells the
  model what the number means. A number with no definition, gated at 0.5, is
  theatre; realizations mode at least defines it as confidence in the transfer.
- **Re-grading is a migration, not a side effect.** Nothing re-grades silently.
  Existing records would be re-graded by an explicit, reviewable run whose diff
  the owner reads before it is committed.

## 6. What is needed to proceed

Owner approval of: the closed vocabularies in section 2, the two hard gates in
section 3, and the band thresholds in section 4. On approval this becomes a
decision entry and a `tools/` grader with tests; until then, grades stay
owner-corrected by hand and every corrected one states its basis.
