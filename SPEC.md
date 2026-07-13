# SPEC.md — Motivation Engine · Baseline
Single source of truth for the project. Read together with `.cursorrules`.
The build order comes from the owner step by step; this file explains WHAT the system is and exactly WHAT each part must contain.

---

## 1. What we are building

Motivation Engine is Ventora's knowledge layer: a scientifically grounded ontology of human motivation mechanisms (why people engage, return, and pay) that will later drive product generation. **Current stage — Baseline:** a private repository of structured data ("the shelves") plus a password-protected web showcase (Control Center) that visualizes all of it. There is NO engine, NO LLM calls, NO database at this stage. Everything is files in the repo rendered by a Next.js app.

Key idea the UI must communicate: this is a transparent machine under construction — every block shows an honest status (live / in progress / planned) computed from actual data files.

## 2. Domain model — the ontology

Four levels, tree-shaped:

```
L0  BRAIN SYSTEMS      — fundamental motivational/affective systems (fixed set of 6)
 └─ L1  MECHANISMS     — reproducible psychological mechanisms (the main records)
     └─ L2  EFFECTS    — observable phenomena produced by a mechanism (inside L1 records)
         └─ L3  IMPLEMENTATIONS — concrete UI/copy/flow embodiments (inside L1 records)
```

### L0 taxonomy (fixed content, ships with baseline)
| id | name | anchors | seed L1 children |
|---|---|---|---|
| S1 | Resource protection & threat | RDoC negative valence / Panksepp FEAR | LA-01, SC-06 |
| S2 | Reward & anticipation | RDoC positive valence / SEEKING | VR-02, CG-05 |
| S3 | Goals & completion | RDoC cognitive systems | HA-04, ZE-07 |
| S4 | Social standing | RDoC social processes | ST-09, SP-08, RE-10 |
| S5 | Self & ownership | RDoC social: self-perception | EN-03, ID-12 |
| S6 | Evaluation & choice | RDoC cognitive: decision | FR-11 |

### L1 mechanism lifecycle
`candidate → incubating → core → deprecated` (also: candidate/incubating → rejected; core → demoted back to incubating). Baseline state: **LA-01 = core-pending (displayed as "incubating"), 11 seed stubs = candidate.** Transitions happen only via dossiers (see §4); the baseline UI only displays statuses, it never changes them.

### Seed mechanism roster (11 stubs + 1 full record)
LA-01 Loss aversion (full record) · VR-02 Variable reward · EN-03 Endowment effect · HA-04 Habit loop · CG-05 Curiosity gap · SC-06 Scarcity · ZE-07 Progress & incompleteness · SP-08 Social proof · ST-09 Status & comparison · RE-10 Reciprocity · FR-11 Framing & anchoring · ID-12 Identity & consistency.

## 3. Data files and their shapes

All data is JSON (UTF-8, English). Types in `/lib/types.ts` must mirror these shapes exactly.

### 3.1 `/registry/taxonomy.json`
```jsonc
{ "version": "1.0.0", "nodes": [
  { "id": "S1", "name": "Resource protection & threat",
    "anchors": { "rdoc": "Negative valence systems", "panksepp": "FEAR" },
    "description": "…1–2 sentences…" }
]}
// coverage per node is COMPUTED in the app: count of L1 records with parent = node.id, by lifecycle status
```

### 3.2 `/registry/mechanism.schema.json` — an L1 record must contain
```jsonc
{
  "id": "LA-01",                 // pattern: [A-Z]{2}-\d{2}
  "slug": "loss_aversion",
  "name": "Loss aversion",
  "version": "1.0.0",
  "level": "L1",
  "parent": "S1",                // L0 node id
  "lifecycle_status": "incubating", // candidate|incubating|core|deprecated|rejected
  "dossier_ref": null,           // path to dossier when it exists
  "provenance": { "proposed_by": "owner|derivation-pipeline", "date": "YYYY-MM-DD" },
  "evidence": { "grade": "A",    // A|B|C
    "basis": "…", "effect_size_note": "…", "caveats": ["…"] },
  "prior_weight": 0.9,
  "mechanism_summary_for_context": "…",   // the text future generation will consume
  "applicability": {
    "funnel_stages": ["…"], "excluded_stages": ["…"],
    "artifact_types": ["paywall", "cancellation_flow", "retention_push", "checkout", "email", "pricing_page", "dashboard_widget", "onboarding", "landing_hero"],
    "preconditions": [{ "predicate": "…", "reason": "…" }],
    "culture_note": "…" },
  "implementations": [           // L3
    { "id": "LA-01-streak", "artifact_types": ["…"], "product_requirements": ["…"],
      "generation_directive": "…", "copy_formulas": ["…"],
      "metrics": ["…"], "observed_effects": [] }],
  "constraints": {
    "hard_rules": [{ "id": "…", "rule": "…", "severity": "block" }],
    "compliance_refs": ["…"], "boundary_test": "…" },
  "relations": [{ "type": "enabled_by|adjacent|hybrid_with", "target": "EN-03", "note": "…" }],
  "telemetry": { "tag_format": "me:LA-01:{implementation_id}", "amplitude_event_property": "mechanism_tags" }
}
```
**Validation hard rules:** `implementations[].metrics` non-empty and `constraints.hard_rules` non-empty, otherwise the record is INVALID. Seed stubs use a reduced shape: `{ id, name, grade_draft, oneliner, parent, lifecycle_status: "candidate" }` and live in `/registry/mechanisms/_seed/` — validated against a separate lax sub-schema.

**LA-01 content:** the full record already exists (provided by the owner as LA-01.json); extend it with the v2 fields above, do not rewrite its content. Its content is the reference example for all layout work.

### 3.3 `/dossiers/dossier.schema.json` — admission gate
Five scoring axes, each 0–3: `evidence`, `product_applicability`, `measurability`, `orthogonality`, `safety`. Thresholds: to enter *incubating* — total ≥ 11 AND evidence ≥ 2 AND safety ≥ 2; to enter *core* — additionally at least one measured effect (from our loop or public corpora). A dossier record: `{ id, mechanism_id, scores{...}, total, evidence_sources[], verdict, decided_by, date, notes }`. Baseline ships the schema + README describing the process; the dossiers folder itself is empty (honest empty state in UI).

### 3.4 `/sources/sources.json` — data-source registry
```jsonc
{ "classes": [
  { "id": "A", "name": "Interfaces", "sources": [
    { "id": "mobbin", "name": "Mobbin", "what": "400K+ screens, flow libraries",
      "access": "subscription", "api": false, "cost": "$120–300/yr",
      "priority": "P0", "phase": "July", "connection_mode": "manual",
      "feeds": ["L3"], "legal_note": "license terms — human curation only" }
  ]},
  { "id": "B", "name": "Science" }, { "id": "C", "name": "Analytics & effect sizes" },
  { "id": "D", "name": "Non-obvious" }
]}
```
Content: port the full source registry provided by the owner (classes A: Mobbin, ScreensDesign, Page Flows, paywall galleries, Wayback CDX, app-store screenshot history, growth.design, Built for Mars, GDC; B: OpenAlex, Semantic Scholar, PubMed/Europe PMC, PsyArXiv/OSF, FORRT, metaBUS, PsychOpen CAMA, Cochrane, NeuroSynth, NeuroVault; C: RevenueCat report, Baymard, GoodUI, Unbounce, Amplitude/Mixpanel/Adjust benchmarks, App Store / Google Play reviews, engineering blogs, Sensor Tower; D: SEC EDGAR earnings calls, Google Patents, FTC/EU enforcement corpus, company handbooks). Every source carries a `connection_mode` — `api` (automated connector), `report` (one-off ingested artifact), `manual` (licensed human curation, never machine-harvested), or `deferred` (P2, not planned this phase; optional `mode_note` records why). There is NO stored status field: source states are computed from the corpus manifests in `/corpora/*/manifest.json` — each manifest declares the sources it harvests in `source_ids[]` (D-013, D-014).

### 3.5 `/decisions/decisions.json`
`{ "decisions": [{ "id": "D-001", "date": "2026-07-12", "title": "…", "body": "…", "area": "architecture|data|process|stack" }] }` — ships with D-001…D-005 (JSON source of truth in git; cards are generated projections; no metrics/constraints → invalid; core roster is seed v0.9; showcase honesty contract) plus new ones added during the build (stack choice, auth).

### 3.6 `/docs/*.md`
Five foundation documents (manifesto, ontology-as-science, architecture, runtime-flow, roadmap). English versions are provided by the owner — Cursor renders them, never edits their content.

## 4. Control Center — the showcase (Next.js app)

### Pages and what each must show
1. **/ Overview** — system map: 7 blocks (Registry · Schema & validator · Card generator · Runtime selection · Corpus: interfaces & science · Corpus: reviews · Telemetry loop) with computed statuses; the honesty-rule banner; counts pulled from files (mechanisms by lifecycle, sources by connection mode with computed completion, decisions count).
2. **/registry** — L0→L1 tree from taxonomy + mechanisms; per-node coverage (how many L1, by status); lifecycle legend; LA-01 expands into a full record view (summary, evidence, preconditions, implementations, constraints, relations); seed stubs render gray as candidates.
3. **/sources** — table from sources.json; filters: class (A–D), priority (P0–P2), mode (api/report/manual/deferred), status (computed); each row shows access type, cost, what it feeds (L-levels), connection mode, computed state, legal note if present.
4. **/dossiers** — empty state: explains the 5-axis gate, thresholds, and that the first dossier (LA-01) is the next milestone.
5. **/decisions** — reverse-chronological feed from decisions.json.
6. **/docs/[slug]** — markdown rendering of the five documents, simple sidebar nav.

### Status computation rules (no hardcoding)
- Registry block: `live` if ≥1 valid full mechanism record exists; count shown as `full/total`.
- Schema & validator: `live` if schema files exist AND CI workflow file exists.
- Card generator: `live` if /cards contains generated output newer than registry (or simply exists at baseline).
- Runtime / corpora / loop blocks: `planned` while their folders are empty — read the file system, render honestly.
- Source states are computed per connection_mode from the corpus manifests (D-013, D-014). A connector is not a source: each /corpora/{dir}/manifest.json declares the sources it harvests in source_ids[]. An `api` source is connected iff ANY manifest lists it in source_ids with last_run.status = "success"; a `report` source is ingested iff additionally that corpus has a data_files entry on disk; `manual` and `deferred` sources show their mode, never a connectivity status. Nothing is stored in sources.json.

### Design tokens (fixed)
Background #0E1512 · panels #151F1A / #1A2620 · borders #243329 · text #E6EFE8 · muted #8CA495 · emerald accent #34D399 (live) · amber #E4B54E (in progress) · slate #7C93A8 (planned) · fonts: Space Grotesk (display), Inter (body), JetBrains Mono (ids, statuses, data). Dark theme only. Every screen has a designed empty state naming the file/pipeline that will fill it and the phase (July/August/September).

## 5. Auth
Single shared password. `middleware.ts` guards everything except /login and static assets. /login posts the password; compare with `env.ACCESS_PASSWORD`; on success set httpOnly cookie signed with HMAC(`env.SESSION_SECRET`), maxAge 30 days; in-memory rate limit 5 attempts/min per IP. No accounts, no roles, no OAuth, no external auth services, no analytics.

## 6. Tooling and CI
- `tools/validate.ts` — validates: every file in /registry/mechanisms against mechanism.schema.json (full) or seed sub-schema (_seed/), taxonomy.json, sources.json, decisions.json, dossier schema integrity. Non-zero exit on any violation. Exposed as `npm run validate`.
- `tools/render-cards.ts` — renders each full mechanism JSON into /cards/{id}.md (human-readable card: summary, evidence, implementations table, metrics, constraints, relations). Exposed as `npm run cards`.
- `.github/workflows/validate.yml` — on every push: install, `npm run validate`, `npm run build`.

## 7. Glossary
- **Mechanism (L1)** — a reproducible motivational mechanism with evidence grade, implementations, metrics, constraints.
- **Dossier** — the scored evidence file that moves a mechanism through lifecycle gates.
- **Corpus** — a dataset harvested from an external source (empty at baseline).
- **Honest status** — a status derived from data on disk, never asserted in code.
- **Showcase / Control Center** — the password-protected Next.js app rendering the shelves.

## 8. Out of scope for Baseline (do not build even if convenient)
Engine/runtime selection logic · any LLM API calls · scrapers/connectors · databases · UI data editing · multi-user auth · analytics/telemetry of the showcase itself.
