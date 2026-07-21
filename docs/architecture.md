# Motivation Engine · Deployment Architecture

Principle: minimum moving parts, maximum transparency. Every component is a managed service, no owned hardware. Everything is visible in logs. **Baseline note:** at the current stage only the git repo + the Vercel showcase exist; everything else below is the target architecture activated in later phases by explicit triggers.

---

## Full scheme

```
        KNOWLEDGE                   DATA                        RAW
 ┌─────────────────┐      ┌──────────────────────┐      ┌──────────────┐
 │  GitHub repo    │      │  Postgres (managed,  │      │ Object store │
 │  registry JSON  │      │  e.g. Supabase)      │      │ (R2/S3)      │
 │  dossiers, L2   │      │  high-volume corpora,│      │ screenshots, │
 │  effects, L3    │      │  tags, telemetry     │      │ flow dumps,  │
 │  realizations,  │      │  (after trigger)     │      │ html         │
 │  proposals/log  │      │                      │      │              │
 └───────┬─────────┘      └──────────┬───────────┘      └──────┬───────┘
         │                           │                          │
         ▼                           ▼                          │
 ┌──────────────────────────────────────────────┐               │
 │            ENGINE = PIPELINES                │               │
 │  GitHub Actions (scheduler + open logs):     │               │
 │   · schema validator (every commit)          │               │
 │   · card generator JSON→MD                   │               │
 │   · derivation pipeline (LLM, quarterly)     │               │
 │   · corpus tagging (LLM, batches)            │               │
 │   · nightly loop job (Amplitude→weights)[Aug]│               │
 │  LLM calls → OpenRouter (Ventora setup)      │               │
 └──────────────────────────────────────────────┘               │
                                                                │
 ┌──────────────────────────────────────────────┐               │
 │       HARVEST WORKER (isolated)              │───────────────┘
 │  managed actors (e.g. Apify) OR 1 small VPS  │
 │  proxies · schedule · retries                │
 │  writes: raw→object store, structure→Postgres│
 └──────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────┐
 │     SHOWCASE · Control Center (Vercel)       │
 │  reads: repo files (registry, effects,       │
 │  proposals, statuses, Actions logs) +        │
 │  Postgres API for high-volume data later     │
 └──────────────────────────────────────────────┘
```

## Where the engine runs

In the solo phase the "engine" is not a service but a set of pipelines. All of them live in **GitHub Actions**:
- **Validator** — on every commit to /registry: a record without metrics/constraints does not pass.
- **Card generator** — on every merge: cards regenerate from JSON.
- **Derivation pipeline** — scheduled and manual (workflow_dispatch): mining grounded corpus records → provenance-gated proposals.
- **Corpus tagging** — batches on demand.

Before a derivation reaches the review queue, STEP B2 applies four ordered quality gates (D-079): corpus-record/DOI/quote grounding, deterministic near-duplicate resolution, a configurable confidence floor, and a configurable per-mechanism volume cap. Pending duplicates are merged by provenance union. A match against authoritative knowledge becomes an owner-reviewed `operation: enrich` proposal with an explicit before/after diff; extraction never writes the artifact itself. Low-confidence or no-material-change enrichments remain visible under `status: held_low_confidence`, collapsed by default. The extraction manifest and `/ops` report proposed, merged, ungrounded, held, capped, and high-confidence-overflow counts so dropped knowledge is never silent.

Why Actions and not a server: every run is an open log with full output. The "no black box" requirement is satisfied by the platform itself: open the Actions tab and see what ran, when, and with what result. Limits (6h per job) suffice for our batches; if a batch outgrows them, it moves to the harvest worker without changing the scheme.

**Runtime selection** (the mechanism filter at generation time) is a local script during the solo phase for M3 runs. In August it moves **inside Ventora's backend** as a pure function — the registry is baked into the build from git. A separate "engine server" does not exist by design: the engine is a layer of Ventora, not an island.

## Where the data lives

Three tiers by data type:

| Tier | What | Where | Why |
|---|---|---|---|
| Knowledge | mechanism registry, dossiers, L2 effects, descriptive realizations, interactions, proposals, schema, decision log | **GitHub repo (private)** | versioning, review, provenance, status history = git history |
| Structure | high-volume corpora (tagged flows, reviews→labels) and telemetry observations | **managed Postgres** (only when an escalation trigger fires) | SQL joins for the loop and pgvector if volume eventually requires it |
| Raw | interface screenshots, flow recordings, html dumps | **object store (R2/S3)** | no egress fees, pennies per TB |

Boundary rule: anything a human edits or approves — git. Pipeline-extracted knowledge first lands in `/proposals/{type}/{id}.json`; it does not affect `/registry`, `/effects`, `/realizations`, `/interactions`, `/dossiers`, or `/segments` before approval. Anything pipelines produce by the thousands may move to Postgres only after an escalation trigger. Anything binary — object store.

### File write surfaces

The app remains read-only for knowledge except for the owner approval path at `/review` (D-076). Its server action may use the existing GitHub token path only to apply a validated proposal. Proposal status, target artifact mutation, and the append-only decision entry must land as one atomic commit. `/corpora/_ops/**` remains the separate operational write surface (D-023). No general-purpose knowledge editor is permitted.

## Where harvesting connects

Harvesting is **isolated from everything else** — it is the only component with legal and network risk and must not live next to the core:
- **Option A (start here):** managed actors (e.g. Apify) for permitted sources. Proxies, retries, scheduling and anti-bot are their problem; output lands in our Postgres/object store via webhooks.
- **Option B (when custom is needed):** one small VPS + a proxy provider, own harvesters. More control, more upkeep.
- **Source order (fixed by the source registry):** first the legal APIs — OpenAlex/Semantic Scholar/PubMed (science), Wayback CDX (interface evolution), SEC EDGAR (earnings calls), open benchmark reports. Grey-area scraping is a last resort and always preceded by a buy-vs-build check with data vendors. Ad corpora are a September add-on layer, not the foundation.

## Cost of the phase

| Component | $/mo |
|---|---|
| GitHub (private repo + Actions) | 0 |
| Vercel (showcase) | 0 |
| Managed Postgres (when activated) | 0–25 |
| Object store | ~5 |
| Harvest actors / VPS + proxies | 50–200 |
| LLM tokens (OpenRouter): derivation + tagging | 100–500 |
| **Total** | **~$150–700/mo**, zero GPUs |

## Escalation triggers (do not act before they fire)

- Corpora arrive (thousands of rows) → activate Postgres.
- Millions of examples requiring semantic search → pgvector over examples; the core stays a registry.
- >500 implementations or conflicting selection rules → registry moves from git to a DB.
- Enough telemetry `implementations[].observed_effects` → learned ranking replaces manual weights. These measured product outcomes are distinct from first-class scientific L2 records under `/effects`.

## What matters for the August handoff

The team receives a system where: the core is in git (review via PR), pipelines are in Actions (open logs), data is in Postgres (SQL access for everyone), and the single product integration point is one selection function inside Ventora's backend. Nothing exotic to maintain.
