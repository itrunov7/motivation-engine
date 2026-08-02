# Motivation Engine

**A knowledge layer that tells software how people actually behave — and shows its work, source by source.**

Most product advice about motivation is folklore. A blog post cites a book, the book cites a study, the study was run on 40 undergraduates in 1987, and somewhere along the way the caveats fell off. By the time it reaches a design decision it is a confident sentence with no provenance and no boundary.

The Motivation Engine is the opposite of that sentence. It is a curated, machine-maintained corpus of behavioural and perceptual science, compiled into **evidence packs** that a product generator reads at build time. Every claim carries the paper it came from, the exact character offsets of the supporting text, a hash of the source it was resolved against, a grade reflecting how much evidence actually backs it, and the conditions under which it stops being true.

If a claim cannot survive that, it does not ship.

---

## What it produces

**Evidence packs** — YAML datasheets, one per product context, generated from the registry. A pack is an *evidence base with minimal assertion*: fact, grade, boundary, realizations, interactions. It is deliberately **not** a set of instructions and contains no examples to copy. The generator consuming a pack decides for itself what to build — which is what keeps generated products varied instead of clones of one house style.

Four layers, from principle to pixel:

| Layer | What lives there | Example shape |
|---|---|---|
| **L0 — Mechanism** | A named regularity of human motivation or perception | Loss aversion, cognitive load, variable reward |
| **L1 — Dossier** | The evidence file behind a mechanism, gated on five axes | Corpus, dissent, boundaries, grade basis |
| **L2 — Effect** | A specific, cited finding within a mechanism | The expertise reversal effect |
| **L3 — Realization** | A concrete interface pattern a generator can act on | Collapse guided walkthroughs after N completed core tasks |

Mechanisms are grouped into motivational (loss aversion, endowment, variable reward, habit, curiosity, scarcity, progress, social proof, status, reciprocity, framing, identity), cross-cutting perception (picture superiority, cognitive load, multimedia, fluency, scanning, information foraging) which is emitted into every pack, and an in-progress interaction & agency set (competence, autonomy, feedback, error recovery, defaults, flow, recognition, aesthetic-usability).

---

## How a claim earns its place

```
harvest → extract → ground → gate → propose → owner review → registry → pack
```

1. **Harvest.** Connectors pull literature from OpenAlex and Semantic Scholar, with Wayback CDX for archived material. Rate-limited, budget-capped, checkpointed and resumable.
2. **Extract.** A cheap pass proposes candidates; a synthesis pass refines the claim. Neither pass is allowed to author provenance.
3. **Ground.** Provenance is resolved **mechanically** by the pass that actually read the source: corpus record id, character offsets into the stored text, and a SHA-256 of that text. The quote is *derived* by slicing at those offsets — never emitted as free text by a model. If the source is ever re-harvested and the hash changes, the span is flagged stale rather than silently pointing at different words.
4. **Gate.** Every citation declares which rhetorical role its span plays — background, hypothesis, method, finding, limitation — and **only a finding may ground a fact**. A span contradicted later in the same document is refused outright. This gate exists because of a real failure: a proposal once quoted a paper's opening premise, verbatim and perfectly grounded, and asserted the exact opposite of what that paper concluded.
5. **Propose.** Nothing is written to the registry by a machine. Candidates land in a review queue as pending proposals.
6. **Owner review.** A human reads the claim against its source and approves, edits, or rejects — with the reason recorded. Every approval is one atomic commit.

---

## The rules that make it trustworthy

**Packs are evidence, not instructions.** Fact, grade, boundary, realizations, interactions — and nothing that reads as a directive. The generator decides.

**Nothing invents science.** Extraction *proposes* with provenance; only owner approval turns a proposal into an artifact. No component may write a claim into the registry on its own authority.

**A corpus that cannot disconfirm is broken.** Dissent is mandatory. An empty dissent category blocks a dossier from going live. Evidence that only ever agrees with itself is not evidence.

**Honest by construction.** Every status on the showcase is computed from the files on disk. Hardcoded progress numbers are forbidden — including in this README, which is why you will not find a count here. Read the live surface instead.

**Grades reflect *our* evidence, not the literature at large.** An effect with one secondary source is graded as an effect with one secondary source, even where the underlying science is well established. Grades rise when sources are added, never because a model felt confident. A single-source basis is capped below the top band unconditionally, and every corrected grade states its basis.

**Invented precision is refused.** A pattern that hardcodes a bare number — "after three completions" — is rejected at extraction, at approval, and at validation. Numeric thresholds must be declared as named tunable parameters carrying their evidence basis, which is usually "none — default heuristic". A plausible number with no study behind it is a lie with a decimal point.

**Every candidate is accounted for.** Runs must balance: candidates in equals proposals out, plus merges, plus drops with named reasons. A run whose ledger does not balance is marked broken, not partial. Silent loss is treated as a defect class, not an inconvenience.

**Estimates never authorize a commit.** A number quoted before the producing code has run is an estimate and is labelled as one. Only measured output may justify a data mutation, and an approval given against an estimate does not survive a differing measurement.

**Decisions are append-only.** Every non-obvious call — including the ones later judged wrong — is written down with its motivating case, its arithmetic, and its consequences. The decision log is a first-class artifact of this repository.

---

## Repository map

```
registry/       mechanism records (L0) and their schemas
dossiers/       evidence files behind each mechanism (L1)
effects/        approved findings with full provenance (L2)
realizations/   approved interface patterns (L3)
interactions/   how mechanisms combine, amplify, or cancel
corpora/        harvested literature, checkpoints, extraction ledgers
packs/          generated evidence packs — never hand-written
proposals/      the review queue: machine output awaiting a human
decisions/      append-only decision log
sources/        source registry and connector state
tools/          connectors, extractor, analyzer, validator, grader
app/            the showcase — every figure computed from the files above
docs/           foundation documents: manifesto, ontology, architecture, runtime
```

---

## Design constraints worth knowing

- **Packs are generated, never authored.** They are rendered from the registry through a pack map. Editing a pack by hand is a bug.
- **The cost funnel.** A cheap stage filters before an expensive one. Budget caps are raised deliberately and never removed; a run is refused before it starts if its estimate exceeds the remaining budget.
- **Manual review is a permanent stage, not scaffolding.** Automated gates catch structural failures. They do not catch a claim that is true to its quote and false to its source. That check is human, by design, and the pipeline is sized around it.
- **Transfer is labelled.** Most of this literature was measured in classrooms, not products. Where a pattern moves from instructional research to product interface, the record says so explicitly. Inference is never presented as measurement.

---

## Status

Under active development. The registry is populated, the evidence machinery is live, and the depth layers — effects and realizations — are being filled one reviewed record at a time. Live counts, coverage and grades are on the showcase, computed from the files in this repository at render time.

Nothing here is medical, psychological or clinical advice. These are datasheets about published research, with their limits attached.
