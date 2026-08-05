# Motivation Engine — working agreement

A curated corpus of behavioural and perceptual science, compiled into evidence packs
that a product generator reads at build time. All documents and code comments in English.

## Roles

- **Owner (Igor)** decides. Approves every artifact, every vocabulary, every grade.
- **You (Claude Code)** implement, diagnose, and measure. You never author science.
- Proposals are machine output awaiting a human. The registry is human-approved truth.

## Constitution — do not violate

1. **Packs are evidence, not instructions.** Fact, grade, boundary, realizations,
   interactions. No directives, no copyable examples. The generator decides for itself.
2. **Honesty rule.** Every status on the showcase is computed from files. Hardcoded
   progress numbers are forbidden anywhere, including READMEs and reports.
3. **Nothing invents science.** Extraction *proposes* with provenance; only owner
   approval creates an artifact. You do not write facts, grades, or boundaries.
4. **A corpus that cannot disconfirm is broken.** Dissent is mandatory; an empty
   dissent category blocks a dossier.
5. **Packs are generated**, never hand-written. Editing a pack directly is a bug.
6. **Cost funnel.** A cheap stage filters before an expensive one. Token caps are
   operational sizing; the USD cap is the safety limit and is never raised to
   unblock a run.
7. **Provenance is structural.** Record id + character offsets + source hash,
   resolved mechanically by the pass that read the source. No model authors a quote.

## Working rules — each earned by a real failure

**Report-only means no run of any kind.** A task that says report, diagnose, or
measure does not authorize dispatch. Runs that consume irreversible resources —
reader coverage, corpus reads, budget — require explicit approval even when the
code permits them.

**Build only what was asked.** If an instruction says a capability does not exist,
say so; do not build it. Unrequested work has broken this project's review surface.

**Estimates never authorize a commit (D-131).** A number quoted before the producing
code has run is an estimate and must be labelled as one. Only measured output may
justify a data mutation. An approval given against an estimate does not survive a
differing measurement — it is re-requested with the measured number.

**Every candidate is accounted for (D-132).** candidates in = proposals out + merges
+ drops with named reasons. A run whose ledger does not balance is `broken`, not
`partial`. Silent loss has appeared four times; treat any uncounted exit as a defect.

**Filters fail open.** A refused candidate is tagged and stored, never destroyed,
and must not consume reader coverage. Every refusal persists its reason and is
replayable offline with no API spend.

**Invented precision is refused.** A pattern stating a bare number ("after three
completions") is rejected at extraction, at approval, and at validation. Thresholds
are named tunable parameters carrying their evidence basis.

**Grades reflect our corpus, not the literature.** One secondary source is graded as
one secondary source. Single-source basis is capped below the A band. Model-asserted
letters are not kept; every corrected grade states its `grade_basis`.

**Never tune a check to match a past verdict.** Flag and filter accuracy is measured
against sources, never against approve/reject history. Agreement with the owner's
prior calls measures fit, not skill. Disagreements are reported, not smoothed.

**Decisions are append-only.** Every non-obvious call gets an entry in
`decisions/decisions.json` with its motivating case, arithmetic, and consequences —
including calls later judged wrong. Ids are allocated automatically; never force one.

**Branch policy (D-136).** `main` is truth. One short-lived branch per review cycle,
merged with `--no-ff` (never squash — the review trail is the point), deleted after.
`ops-progress` is a named data-channel exemption: three workflows force-push run
progress there for `/ops`. Never delete or merge it.

## Context discipline

Never read corpus records into context. `corpora/evidence/`, `corpora/extraction/`,
`analysis/` and generated artifacts are bulk data — get every number by running a
committed script and reading its printed output. Reading records directly is both
expensive and how estimates get mistaken for measurements.

`corpora/_ops/` is the exception, and it is not a grudging one: it holds configuration
— model tiers, token limits, budget caps, schemas — and is read directly, like any
config file. The rule above is about volume and about numbers derived from records;
a cap is neither. An agent that cannot read `corpora/_ops/extraction.json` cannot
name the model it is about to spend against, which is how a decision came to cite a
model the pipeline is not configured to call.

## Before reporting complete

`npm run validate`, `npm run build`, and the relevant `test:*` suites must pass.
State which you ran. If a pre-existing failure is present, prove it predates your
change rather than assuming it.

## Known open defects — do not silently work around

- `span_role` may not be wired into the refusal path; `span_role_not_finding` and
  `span_role_missing` have never fired.
- The stage-3 relevance pre-filter reports zero skips on 19 of 20 runs (D-161).
- Rejection accounting gap: 17 reported vs 16 files present.
- Duplicate detection: `CONCEPT_GROUPS` is hand-seeded for cognitive-load vocabulary;
  `min(trigger, action)` misses same-action/different-trigger duplicates.
- Transferability filter v1: VARIABLE is a lexicon, not a judgement. Ten of eighteen
  mechanisms predict zero transferable proposals under it.
