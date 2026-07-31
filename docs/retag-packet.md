# Retag packet — the category vocabulary, measured, not applied

Captured 2026-07-31 against HEAD. Nothing in this document has been written to
any corpus. `corpora/evidence/**` on disk still carries the pre-retag
categories, and the reversal vocabulary in section 4 is live in the extraction
gate only — it has never touched `DISSENT_MARKERS`.

Two vocabularies are in play, and the packet keeps them apart because they do
different jobs and only one of them is the owner's to approve:

| | `DISSENT_MARKERS` | `REVERSAL_MARKERS` |
|---|---|---|
| Where | `tools/connectors/evidence.ts` | `lib/span-role.ts` |
| What it does | tags a corpus record `dissent` | refuses an extraction candidate whose own source contradicts it downstream |
| Feeds | the grading rubric's input layer | one quality gate inside `tools/extract.ts` |
| Status | **frozen** since D-130, awaiting this session | extended in D-133 as mechanics |

Reproduce everything here with `npm run retag:categories` and
`npm run markers:coverage`. Both are read-only and print to stdout only, per
D-131.

---

## 1. The retag, in aggregate

```
Category retag under the D-130 rules — 4444 records across 22 corpora

AGGREGATE, all corpora
  category        before    after   delta
  foundational       414 →    771    +357
  meta-analysis      374 →    412     +38
  replication        493 →    493       ·
  dissent           1149 →    729    -420
  recent            1540 →   1540       ·
  (no category)     1590 →   1502     -88
  records changed   1043
```

Two of these four movements are relabelled by **D-135**, because the label
decides who gets to approve the change:

- **foundational +357 (+86%) is a NEW ADMISSION RULE**, not the bug fix D-130
  files it as. The old rule admitted a record at 1000 raw citations; the new one
  adds a second route — a sustained rate, floored at 10 years old and 250
  citations total. Nothing was broken and repaired. The *definition* of
  foundational changed, from "cited a great deal" to "cited a great deal, or
  cited steadily for a long time", and the rubric's most heavily weighted input
  nearly doubled.
- **dissent −420 is a SEMANTIC NARROWING**, which D-130 already says; what is
  new is that the share is measured. 562 records lose the tag, 142 gain it.
  **239 of the 562 (42.5%)** lose it solely because bare `question` no longer
  fires, against the 43% quoted before the instrument existed. The next largest
  single cause is bare `does not` at 103 records (18.3%).

The other two D-130 changes — singular-only negation, and the container-blind
review test — are bug fixes as filed and are not in dispute.

## 2. Per corpus

Only corpora whose counts move are listed.

```
  mechanism   foundational  meta-analysi   replication       dissent        recent
  CG-05               4→11         14→14         26→26         41→19         81→81
  CG-05.regression     1→2           0→0           1→1           6→0         14→14
  CL-14              33→71         12→17         91→91       187→117       245→245
  EN-03              13→33         23→23         18→18         36→24         32→32
  FR-11              37→64         52→52         30→30         45→33         67→67
  FR-11.regression     2→2           1→1           9→9           6→7         19→19
  HA-04              51→87         43→44           3→3         44→27         60→60
  ID-12              45→56          9→12         32→32         34→16         31→31
  IF-18                1→4           5→9           9→9         74→43         82→82
  LA-01              31→46         28→30         25→25         37→30         61→61
  MM-15              10→29         49→60         15→15         70→56       124→124
  PF-16               8→23          7→10         59→59         99→82       127→127
  PS-13              42→72         10→12         42→42        140→93       115→115
  RE-10               5→13           7→7         32→32         29→14         46→46
  SC-06               4→21         16→16         33→33         43→29         89→89
  SC-17               3→14           6→9         25→25        102→55       165→165
  SP-08              10→33         13→14         29→29         59→31         76→76
  SP-08.regression     2→2           0→0           0→0           5→2         15→15
  ST-09              51→67         12→13           2→2         40→26         43→43
  VR-02              40→76         35→37           2→2         27→10         23→23
  ZE-07              20→44         32→32         10→10         25→15         25→25
```

### The one safety check that fires

```
DISSENT-ZERO CHECK (D-019 gate in tools/validate.ts)
  CG-05.regression: 6 → 0  (side file, not read by the gate)
```

D-019 requires every mechanism corpus to hold at least one dissent record, so
the ontology cannot quietly become a collection of things that only ever
worked. Exactly one file crosses to zero, and it is a `.regression` side file
that the gate does not read — so applying the retag would not break D-019. It
is reported anyway, because "the check does not read this file" is a fact worth
seeing before an apply rather than after.

## 3. Which dissent marker carries the weight

`fires` counts records the marker matches; `sole reason` counts records where
it is the only marker that matched, i.e. records that lose the tag if it goes.

```
  marker                    fires  sole reason
  critique                    156          130
  boundary-condition          143          127
  neg+outcome-verb            135          103
  neg+claim-verb               62           38
  no-evidence                  52           34
  no-significant               52           42
  contrary-to                  50           30
  overestimated                40           27
  reconsider                   37           25
  only-a-weak                  30           19
  fail-to+verb                 24           11
  publication-bias             15            6
  opposite                     12            6
  reverse-effect               11           10
  call-into-question           10            4
  absence-of                    9            5
  not-replicate                 9            1
  null-result                   5            1
  does-not-generalise           4            0
  failed-replication            2            1
```

Two markers do most of the work and neither is a negation: `critique` and
`boundary-condition` are between them the sole reason for 257 records. If the
session wants to argue about a single line of vocabulary, argue about those two
rather than about the long tail — `does-not-generalise` is the sole reason for
nothing at all.

## 4. Samples, with the matched text

Seeded samples of 15, drawn deterministically so re-running reproduces the same
records. Full output from `npm run retag:categories`.

### 15 of 357 that GAIN `foundational` — the new admission rule in action

```
  cr_4067a63e4a55a74b4b3b0649 FR-11 2003 cit=846 type=article
    AUA Guideline on Management of Benign Prostatic Hyperplasia (2003)...
    old [dissent] -> new [foundational, dissent]
    citations=846 age=23y rate=36.8/y foundational=true
  cr_d941bb256cf792ec6d725d61 PS-13 2007 cit=665 type=article
    siRNA Delivery into Human T Cells and Primary Cells with Carbon-Nanotube Transporters
    old [] -> new [foundational]
    citations=665 age=19y rate=35.0/y foundational=true
  cr_df2398fe5448788c72a66333 MM-15 2010 cit=591 type=article
    Applying the science of learning to medical education
    old [dissent] -> new [foundational]
    citations=591 age=16y rate=36.9/y foundational=true
  cr_70335682be077a03fcef6d63 SP-08 2014 cit=970 type=review
    Consumers' perceptions and preferences for local food: A review
    old [meta-analysis] -> new [foundational, meta-analysis]
    citations=970 age=12y rate=80.8/y foundational=true
  cr_68739e8507a3076b45e286d1 CL-14 2003 cit=531 type=article
    Structuring the Transition From Example Study to Problem Solving...
    old [] -> new [foundational]
    citations=531 age=23y rate=23.1/y foundational=true
  cr_da66d536a46b05e0205ad839 ZE-07 1999 cit=955 type=book
    The Political Economy of Democratic Decentralization
    old [dissent] -> new [foundational, dissent]
    citations=955 age=27y rate=35.4/y foundational=true
```

Note what these are. `siRNA delivery into human T cells`, `the M2 proton
channels of influenza`, `an AUA guideline on prostatic hyperplasia` — heavily
cited, genuinely foundational, and foundational to *medicine*, not to
motivation. The admission rule is doing what it says; whether a rubric for
motivation mechanisms should weight them is the owner's call, and it is a
different question from whether the rule is correct.

### 15 of 562 that LOSE `dissent`

```
  cr_dfb31703221ea4844f2dffb0 SP-08 2020 cit=32 type=-
    A Simplified Quantitative Real-Time PCR Assay for Monitoring SARS-CoV-2 Growth in Cell Culture
    old [replication, dissent] -> new [replication]
    matched under the new markers: NOTHING
  cr_fab90d5edc2df9ea88ed6dd6 RE-10 2025 cit=1 type=-
    Integrating upstream and downstream reciprocity stabilizes cooperator-defector coexistence...
    old [dissent, recent] -> new [recent]
    matched under the new markers: NOTHING
  cr_9c8aa1da6b0853dd3690c2f3 PS-13 2019 cit=18 type=-
    Does Threat Have an Advantage After All? - Proposing a Novel Experimental Design...
    old [dissent] -> new []
    matched under the new markers: NOTHING
  cr_510f10144b42345fd2bd05a7 SC-06 2025 cit=2 type=-
    Leveraging social presence to drive impulsive buying in live shopping...
    old [dissent, recent] -> new [recent]
    matched under the new markers: NOTHING
  cr_9a267d88c6f8b594efa14132 VR-02 2021 cit=90 type=review
    Why and How Should Cognitive Science Care about Aesthetics?
    old [meta-analysis, dissent, recent] -> new [meta-analysis, recent]
    matched under the new markers: NOTHING
  cr_cf8813f1f2578e0146f5a6a0 CL-14 2026 cit=0 type=article
    Project Nephilim-(Vesper-01), A Virtual Aperiodic Non-Von-Nuemann Topological State Machine.
    old [replication, dissent, recent] -> new [replication, recent]
    matched under the new markers: NOTHING
```

This is the sample to read hardest, because it is the one that could be wrong.
`Does Threat Have an Advantage After All?` is a title that is *asking a
question about a claimed effect* — precisely the case bare `question` was
catching, and precisely the case that made bare `question` fire on 239 records
that were nothing of the kind. Dropping the catch-all loses this record. The
session decides whether that trade is right, and the honest framing is that the
narrowing is not free.

### 15 of 142 that GAIN `dissent`

```
  cr_ddb11f868af6b372f66d557c PS-13 2026 cit=1 type=article
    Challenging Dual-Coding Theory: Picture Superiority Effects Persist in Aphantasia.
    old [recent] -> new [dissent, recent]
    matched: contrary-to
  cr_b4fc66c69fb7143a7a7eb4f5 PS-13 2025 cit=6 type=-
    The Human Superiority Effect in Advice Taking: A Multimethod Exploration...
    old [recent] -> new [dissent, recent]
    matched: no-significant, opposite
  cr_eb13a00187964cf6642c2163 CL-14 2000 cit=447 type=article
    Don't mind if I do: Disinhibited eating under cognitive load.
    old [replication] -> new [replication, dissent]
    matched: opposite
  cr_05da963835ab9185c45e7cdc SP-08 2024 cit=16 type=-
    Effectiveness and context dependency of social norm interventions: five field experiments...
    old [replication, recent] -> new [replication, dissent, recent]
    matched: neg+outcome-verb
  cr_84d4d33c8052062fc9f09fc9 HA-04 2022 cit=56 type=-
    Striatal dopamine signals are region specific and temporally stable...
    old [recent] -> new [dissent, recent]
    matched: neg+outcome-verb
  cr_59edf7ea76d96ecc63b6324f FR-11.regression 2022 cit=14 type=-
    TREX (transcription/export)-NP complex exerts a dual effect on regulating polymerase activity...
    old [replication, recent] -> new [replication, dissent, recent]
    matched: reverse-effect
```

The gains are better records than the losses. `Challenging Dual-Coding Theory`
and `five field experiments on nudging` are dissent in the sense the rubric
means. The last one is the shape to be suspicious of: a molecular-biology
abstract matching `reverse-effect` on virology vocabulary, in a `.regression`
side file. It is one record in a file the D-019 gate does not read, and the
same false-positive shape is what the extraction-side exclusions in section 5
were built to handle.

---

## 5. The extraction reversal vocabulary — final list, verbatim

This is `REVERSAL_MARKERS` in `lib/span-role.ts` as shipped by D-133: 18 named
markers, up from 10. It is the answer to "post the final marker list so I see
what counts as contradiction."

```
reverse                    \breverse[ds]?\b(?![-\s]?(?:engineer|transcri))
reversal                   \breversal\b
opposite                   \bopposite\b
contrary-to                \bcontrary to\b
in-contrast-to-prediction  \bin contrast (?:to|with) (?:our |the |these |previous |prior |earlier )*
                           (?:prediction|expectation|hypothes[ie]s|assumption|claim)\w*\b
only-a-weak                \bonly (?:a |an )?(?:very )?(?:weak|small|modest|marginal|negligible)\b
fail-to+verb               \bfail(?:ed|s|ure|ures|ing)?\s+to\s+(?:replicate|reproduce|generalise|
                           generalize|hold|extend|transfer|apply|support|confirm|corroborate|predict|
                           obtain|persist|materialise|materialize|survive|appear|emerge|find|show|arise|
                           occur|differ|improve|benefit|help|increase|reduce|decrease|affect|influence|
                           outperform|exceed|facilitate|enhance|moderate|mediate|eliminate)\b
neg+claim-verb             \b(?:did|does|do)\s+not\s+(?:replicate|reproduce|generalise|generalize|hold|
                           extend|transfer|apply|support|confirm|corroborate|predict|obtain|persist|
                           materialise|materialize|survive|appear|emerge|find|show|arise|occur)\b
neg+outcome-verb           \b(?:did|does|do)\s+not\s+(?:differ|improve|benefit|help|increase|reduce|
                           decrease|affect|influence|outperform|exceed|facilitate|enhance|moderate|
                           mediate|eliminate)\b
was-not+participle         \b(?:was|were|is|are|has|have|had)\s+not\s+(?:replicated|reproduced|
                           generalised|generalized|supported|confirmed|corroborated|observed|found|
                           detected|significant|reliable|evident|present|borne out|obtained|sustained|
                           maintained)\b
no-significant             \bno (?:statistically )?(?:significant|reliable|detectable|measurable|
                           discernible|appreciable) (?:effect|difference|differences|benefit|advantage|
                           improvement|gain|change|association|correlation|relationship|interaction)\b
no-effect-of               \bno effect (?:of|on|was|were|for)\b
no-evidence                \bno evidence (?:of|for|that|was|has)\b
no-support-for             \b(?:no|little) support for\b
null-result                \bnull (?:result|results|finding|findings|effect|effects)\b
absence-of                 \babsence of (?:an? )?(?:\w+ ){0,2}(?:effect|effects|difference|differences|
                           benefit|association|correlation|evidence|support)\b
contradicts                \b(?:contradict(?:s|ed|ing)?|refut(?:e|es|ed|ing)|disconfirm\w*)\b
effect-disappeared         \b(?:effect|effects|advantage|advantages|benefit|benefits|difference|
                           differences)\b(?:\s+\w+){0,3}\s+(?:disappear(?:ed|s)?|vanish(?:ed|es)?|
                           was eliminated|were eliminated)\b
```

Every marker requires a verb or a noun phrase. There is no bare `however`, no
bare `but`, no bare `question` — the four catch-alls D-130 removed from dissent
are deliberately absent here too. Line wrapping above is for reading only; the
patterns are single-line in the source.

The one exclusion worth explaining: `reverse` refuses to fire on
`reverse-engineer` and `reverse transcri…`. Both were measured, not guessed —
`reverse transcription` appears in 13 corpus records and `reverse-engineering`
in 2, and neither is a claim about an effect reversing.

## 6. Coverage, before and after

```
  marker reach (any marker fires after the first sentence)
    before (D-129, 10 markers): 356 (10.9%)
    after  (D-133, 18 markers): 583 (17.9%)
    delta: +227 records (+7.0% of the denominator)

  what the gate would actually refuse (marker AND >=3 shared content words)
    before: 133 (4.1%)
    after:  236 (7.3%)
```

The second pair is the one that matters. A marker firing somewhere in an
abstract does not refuse anything; a candidate is refused only when the
contradicting sentence also shares at least three content words with the quote
being proposed. That overlap requirement is where the precision lives, which is
why widening the vocabulary is safe and widening the overlap gate would not be.

### The 7.5% / 31.3% pair, resolved

**31.3% reproduces exactly, and it is the reach of bare `however` on this
denominator — nothing else.** The "ceiling" was a discourse marker's frequency,
not a measurement of how much reversal the corpus contains. **7.5% does not
reproduce** from any basis reconstructable here: whole corpus or CL-14 alone,
title-plus-abstract or abstract alone, whole text or first or last tail
sentence. It is superseded by the measured 10.9% baseline rather than compared
against.

### Which is why the ceiling is not a target

```
  named phrasings + catch-alls: 2067 (63.5%)
  reached by named phrasings:   583 (17.9%)
  reachable ONLY by catch-alls: 1484 (45.6%)
  catch-alls alone would reach: 1997 (61.4%)
    bare-however   on its own:  1020 (31.3%)
    bare-negation  on its own:  1171 (36.0%)
    bare-question  on its own:   529 (16.3%)
    bare-but       on its own:  1256 (38.6%)
```

45.6% of the corpus is reachable *only* by catch-alls. Closing that distance
means re-importing bare `however`, bare `but`, bare `does not` and bare
`question` — the exact four shapes the neighbouring vocabulary just removed for
firing on hundreds of records for no reason. The gap between 17.9% and 63.5% is
a measurement of how much discourse noise exists, not of how much work is left.

### Per-marker, after

`first to fire` counts records where the marker is the first match; `sole
reason` counts records no other marker would have caught.

```
  reverse                     83    48        no-significant       43    41
  reversal                    24    18        no-effect-of         15    14
  opposite                    48    33        no-evidence          33    30
  contrary-to                 43    32        no-support-for        6     6
  in-contrast-to-prediction    1     0        null-result           0     0
  only-a-weak                 27    19        absence-of            5     5
  fail-to+verb                24    16        contradicts          22    22
  neg+claim-verb              99    86        effect-disappeared    2     2
  neg+outcome-verb            74    63        was-not+participle   34    31
```

`null-result` fires on nothing and `in-contrast-to-prediction` on one record.
Both are kept: a marker that costs nothing and catches the exact phrasing the
owner named is worth keeping even at one hit, and a zero here is evidence about
the corpus, not about the marker.

## 7. DISSENT variant — computed, NOT applied

The request was to see what the same phrasings would do to the dissent
vocabulary without doing it. `tools/connectors/evidence.ts` is unmodified and
the D-130 freeze holds.

```
  denominator: 4444 stored records
  dissent as shipped today: 729 (16.4%)
  dissent if the D-133 reversal phrasings were added: 851 (19.1%)
  delta: +122 records (+2.7%)

  the 8 phrasings not already in DISSENT_MARKERS, by records they alone would add:
    reverse                    36        was-not+participle   22
    reversal                   15        no-effect-of         14
    in-contrast-to-prediction   0        no-support-for        5
    contradicts                19        effect-disappeared    2
```

Ten of the eighteen reversal markers are already in `DISSENT_MARKERS` under the
same or a near-identical pattern; only these eight are new to it. Adopting them
would take dissent from 729 to 851 — recovering 122 of the 420 the narrowing
removed, and recovering them through named phrasings rather than by restoring
the catch-alls.

The session sees both variants at once and decides once, per D-131. No
re-measurement happens before that decision.

---

## What this packet asks for

1. Approve or reject the **retag** (`npm run retag:categories --apply`), knowing
   it is a new admission rule for `foundational` and a semantic narrowing for
   `dissent`, not four bug fixes.
2. Approve or reject **adding the 8 new phrasings to `DISSENT_MARKERS`**
   (729 → 851).
3. If both are approved, they apply in one run and the corpus is measured once
   afterwards.
