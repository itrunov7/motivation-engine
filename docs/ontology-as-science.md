# Motivation Engine · The Ontology as a Scientific System
### Architecture v2 — not a list, but a living taxonomy with an evidence pipeline

**The problem this document solves:** a flat list of N hand-picked mechanisms is an opinion, not a system. It cannot answer: why these? why this many? what did we miss? when does a mechanism expire? Below is an architecture in which the composition of the ontology is derived, verified, and revised by a formal process.

---

## 1. Taxonomy: four levels instead of a flat list

Mechanisms are not peers and not independent — they are realizations of deeper brain systems:

```
L0  BRAIN SYSTEMS          — fundamental motivational/affective systems
 └─ L1  MECHANISMS         — reproducible psychological mechanisms (our records)
     └─ L2  EFFECTS        — observable phenomena a mechanism produces
         └─ L3  IMPLEMENTATIONS — concrete embodiments in interface/copy/flow
```

**L0 is not invented — it is taken from established scientific frameworks.** Two anchor frames:

- **NIH RDoC (Research Domain Criteria)** — the official research-domain framework: negative valence systems (threat, loss), positive valence systems (reward, its anticipation and learning), cognitive systems, social process systems (affiliation, status, self-perception), arousal/regulatory systems.
- **Panksepp's primary affective systems** — SEEKING (anticipation/exploration), FEAR, RAGE, PANIC/GRIEF (separation), CARE, PLAY, LUST — the neuroethological frame of the "ancient brain."

Working L0 for v1 (each node documents its mapping to both frames):

| L0 node | Anchor | Example L1 |
|---|---|---|
| S1 Resource protection & threat | negative valence / FEAR | loss aversion, scarcity |
| S2 Reward & anticipation | positive valence / SEEKING | variable reward, curiosity gap |
| S3 Goals & completion | cognitive systems | goal-gradient, incompleteness, habit loop |
| S4 Social standing | social processes | status/comparison, social proof, reciprocity |
| S5 Self & ownership | social: self-perception | endowment effect, identity/consistency |
| S6 Evaluation & choice | cognitive: decision | framing, anchoring |

**Why L0 matters practically:** it gives a coverage audit. "Did we miss anything?" turns from a philosophical question into a tabular one: is every L0 node covered by at least two grade-A/B mechanisms? An empty or thin node = a direction for the derivation pipeline (§4). Example: if S4 is covered by a single grade-B mechanism, the system itself highlights the gap.

**Why L2 is separate from L1:** one mechanism produces several effects with different evidence strength. Loss aversion (L1, grade A) → endowment effect (L2, A), sunk cost (L2, B+), loss framing (L2, A). Loop weights and observed effects live at L2/L3 — where measurement happens; science lives at L1 — where the mechanism is.

## 2. Mechanism lifecycle: how nodes enter, live, and die

Every L1 record has a status; transitions happen only by formal criteria:

```
CANDIDATE ──▶ INCUBATING ──▶ CORE ──▶ DEPRECATED
   │              │            │
   └── rejected   └── rejected └── demoted → INCUBATING
```

- **CANDIDATE** — proposed by the derivation pipeline or a human. Has a dossier (§3); does not participate in generation.
- **INCUBATING** — the dossier passed the scientific threshold, but no product data yet. Allowed into generation only in A/B mode with a small weight (the machine gathers its own data about it).
- **CORE** — science + at least one measured effect in our loop or in public corpora. Full participation in selection.
- **DEPRECATED** — the science was retracted (replication failures), or loop effects are consistently null/negative, or a regulatory ban. Excluded from generation; history preserved.

**Key consequence:** "12 mechanisms" stops being dogma. It is not a number but the current state of the registry: how many nodes are in CORE right now. Tomorrow it can be 9 or 17 — by data, not by taste.

## 3. Admission gate: the candidate's scored dossier

Every candidate gets a dossier scored on five axes (0–3 each):

1. **Evidence** — is there a meta-analysis? Did it survive replication projects (Many Labs, FORRT)? Cross-cultural data? Effect size and heterogeneity.
2. **Product applicability** — implementable in a digital interface/copy/flow? Are there reference live products?
3. **Measurability** — does a proxy metric exist that our telemetry can reach?
4. **Orthogonality** — does it duplicate an existing node? (If so, it is an L2 effect of an existing L1, not a new mechanism.)
5. **Safety** — is the dark-pattern boundary definable? Regulatory red flags?

**Thresholds:** into INCUBATING — total ≥ 11 with no axis below 2 on evidence/safety. Into CORE — additionally a measured effect. The dossier is a standard artifact: `/dossiers/{id}.md`, drafted semi-automatically (§4), approved by the ontology owner.

## 4. Derivation pipeline: the machine that finds mechanisms itself

This is the original "AI reads science" idea — applied first to the composition of the ontology itself:

```
SOURCES                        MINING                     GATE
meta-analyses (via        ──▶  LLM pipeline:        ──▶  dossier scoring ──▶ CANDIDATE
OpenAlex, PubMed,              extract mechanisms,        (§3)
Cochrane-style reviews)        deduplicate against
replication databases          current registry,
(FORRT, Many Labs, OSF)        draft dossiers with
citation graphs                references
(Semantic Scholar)
```

- Pipeline runs — quarterly plus on demand ("check coverage of node S4").
- A run's output is not "truth" but a candidate queue with dossiers for approval. The human (ontology owner) is the final gate. The machine proposes, evidence is weighed, the decision is logged.
- The same pipeline works downward: monitoring replication databases → flag "the science under mechanism X is shaking" → status review.

## 5. Versioning and provenance

- The ontology is versioned as a whole (semver): adding an L1 — minor; a CORE↔ status change — major for consumers (the generation pipeline).
- Every node stores provenance: who/what proposed it (pipeline run #N / human), the dossier, the date and rationale of every status transition.
- The showcase (Control Center) displays: the L0→L1 tree with coverage, lifecycle statuses, the candidate queue, transition history. Transparency = you see not only WHAT is in the core but WHY and HOW it got there.

## 6. What happens to the current 12 — and to the deadlines

The current 12 get an honest status: **seed hypotheses v0.9.** They are not an "approved core" but a starting set assembled expertly to get moving. Then two parallel tracks:

- **Track A (deadlines do not move):** July — records for the 12 seed mechanisms + the live M3 run; August — integration. Seed mechanisms enter generation as INCUBATING→CORE as data arrives.
- **Track B (scientific rigor, in parallel):** the first derivation-pipeline run over all 12 — full dossiers, scoring, L0 coverage audit. Expected result: most confirm with high scores, 1–2 change formulation or level (turn out to be L2 effects), 2–4 new candidates appear from thin nodes. That is normal — that is how a living system should behave.

**Principle:** scientific rigor is delivered through the lifecycle and the pipeline, not by postponing the start. Science itself works this way: publish → replicate → revise.

## 7. What this changes in storage — almost nothing (for now)

The JSON registry in git remains the source of truth: fields `level`, `parent` (L0 node), `lifecycle_status`, `dossier_ref`, `provenance` are added. A tree of ~6 L0 × ~15 L1 × ~40 L2 × ~150 L3 is hundreds of nodes — git+JSON holds it easily. A graph database — on the previously defined triggers (thousands of edges, conflicting selection rules). We do not let structural complexity outrun the complexity of the content.
