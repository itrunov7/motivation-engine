# Owner session — 2026-07-31

The agenda. Four decisions are on the table; three of them (D-132, D-134, D-135)
are already implemented because they are mechanics, and are here to be read
rather than approved. The fourth is the only one that needs your judgement
before anything changes on disk.

**Nothing has been applied.** No extraction run, no `--apply`, no retag. The
corpus on disk is byte-identical to what it was before this work started, and
the repository is frozen in that state until this session.

## The four artifacts

| | Document | What it is |
|---|---|---|
| 1 | [`docs/retag-packet.md`](retag-packet.md) | the category retag and the contradiction vocabulary, measured and not applied |
| 2 | [`docs/computed-grading.md`](computed-grading.md) §5, §5a | the corrected corpus figures and the D-130 relabels |
| 3 | `decisions/decisions.json` D-132 | the conservation ledger |
| 4 | `corpora/extraction/ledger.json` | the ledger itself, one entry per historical run |

## What needs your decision, in priority order

### 1. The dissent vocabulary — the only open question (D-131 gate)

`DISSENT_MARKERS` has been frozen since D-130 waiting for this. You see both
variants at once, decide once, and the corpus is measured once afterwards.

- **Variant A, the retag as shipped**: dissent 1149 → 729, foundational 414 →
  771.
- **Variant B, retag plus the 8 new phrasings**: dissent 729 → 851, recovering
  122 of the 420 lost — through named phrasings, not by restoring the
  catch-alls.

Full samples with matched text, the per-marker sole-reason table, and the
D-019 dissent-zero check are in the retag packet. The record to argue over is
`Does Threat Have an Advantage After All?`: it loses the tag under both
variants, it is real dissent, and it was caught only by the bare-`question`
catch-all that also fired on 239 records that were nothing of the kind.

### 2. The two D-130 relabels (D-135)

`decisions.json` is append-only, so D-130 is untouched; D-135 carries the
relabel and cites it.

- The citation-rate foundational route is a **NEW ADMISSION RULE** (+357
  records, **+86%**), not a bug fix. Nothing was broken and repaired — the
  definition of *foundational* changed, and the rubric's most heavily weighted
  input nearly doubled. If it stays filed as a fix, that change never gets
  approved by anyone.
- Dropping bare `question` is a **SEMANTIC NARROWING**, which D-130 already
  says. What is new is the measurement: **42.5%** of dissent losses, 239 of 562,
  against the 43% quoted before the instrument existed.

`docs/computed-grading.md` also had its corpus figures corrected: **374
meta-analyses and 493 replications across all 4444 records**, not "12 and 91".
The old numbers were single-corpus and read as corpus-wide. The consequence
that section was drawing survives the correction — the corpus is not thin, the
classifier simply does not tag the records that actually get cited.

## What is already done, and is here to be read

### D-132 — candidate conservation, enforced

Every extraction run must now account for every candidate it produced. Four
equations, all enforced by `npm run validate`:

```
candidates       == candidates_cheap + candidates_strong
candidates_cheap == dropped_ungrounded_cheap + into_synthesis
into_synthesis - candidates_strong == consolidated_by_synthesis   (or expanded_by_synthesis)
candidates_strong == proposed + proposed_enrich + merged_into_pending
                   + held_low_confidence + failed_validation
                   + dropped_ungrounded_strong + dropped_volume_cap
```

A run that fails any of them is written **`broken`**, not `partial`, and
validation fails on it. A run with no ledger entry at all also fails — the
invariant cannot be satisfied by omission.

**This is the third appearance of one defect class**, and D-132 cites all
three: the 30-for-30 drop with only a counter behind it (D-104, four runs), the
cheap→strong 8→7 shrink that D-105 split the counters for but never balanced,
and the 8-of-15 untracked here.

**Correction to the record:** an earlier report put the 8-of-15 on the
realizations run. It belongs to the **effects** run `cl14-validation-1`. The
realizations run balances, and its three refusals are persisted per candidate.

Two accounting defects were found in the process and had to be fixed before any
identity could hold. `merged` was counting two different fates — a candidate
absorbed into a pending proposal (no output file) and an `enrich` proposal
against a real artifact (which is an output file) — so `proposals_out` was not
derivable from the counters at all. And `candidates` was a sum of two stages
rather than a population, so a single-line identity over it was never
meaningful, which is why the invariant is staged.

The eight historical runs, backfilled honestly:

```
2026-07-31 realizations  reconstructed      complete, from the committed rejected file
2026-07-31 effects       partly reconstructed  strong stage named; cheap-pass lineage is gone
2026-07-24 effects ×2    reconstructed      failed before any candidates existed
2026-07-24 effects ×3    unreconstructable  rejected candidates not persisted before D-105
2026-07-23 effects       unreconstructable  same
```

`unreconstructable` requires a stated reason and is a provenance fact, not a
grandfather clause. The four D-104 runs balance in aggregate (100% ungrounded)
*and* have no per-candidate lineage, and the ledger says both things rather
than picking the flattering one.

### D-133 — reversal vocabulary extended, and the "ceiling" explained

`REVERSAL_MARKERS` goes from 10 to 18 named markers. This is the extraction
gate — mechanics, not science, and not the dissent vocabulary. Marker reach
10.9% → 17.9%; what the gate would actually refuse, 4.1% → 7.3%.

**The 31.3% "ceiling" was the frequency of the word `however`.** It reproduces
exactly and is nothing else. The 7.5% does not reproduce from any basis
reconstructable here and is superseded by the measured 10.9%. 45.6% of the
corpus is reachable only by catch-alls, so the distance to that ceiling is a
measurement of discourse noise, not a target — closing it means re-importing
the four bare markers D-130 just removed. The full 18-marker list is in the
retag packet §5, verbatim, as requested.

### D-134 — a test may not write to a committed path

`analyzer.test.ts` was regenerating `analysis/sufficiency-matrix.json` in place
every run. `main()` now takes an output path and the test writes to a temp dir.

The committed matrix needed no restore: a fresh computation was diffed against
it and they are identical apart from `generated_at`, so the claim is measured
rather than asserted. A sweep of the other test files found `github.test.ts`
was never wired into CI at all. CI now runs all 11 test scripts — 174 tests —
and then `git diff --exit-code`, so a test that dirties the tree fails the
build rather than being noticed by hand later.

## Definition of done for this batch

```
npm run validate   green — 135 decisions, 8 runs balance in the ledger
npm run build      clean
11 test scripts    174 tests passing
git diff           clean after the full suite
```

No extraction run. No `--apply`. No retag. Frozen here.
