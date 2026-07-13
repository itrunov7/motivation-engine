# Motivation Engine · Deployment Architecture

Principle: minimum moving parts, maximum transparency. Every component is a managed service, no owned hardware. Everything is visible in logs. **Baseline note:** at the current stage only the git repo + the Vercel showcase exist; everything else below is the target architecture activated in later phases by explicit triggers.

---

## Full scheme

```
        KNOWLEDGE                   DATA                        RAW
 ┌─────────────────┐      ┌──────────────────────┐      ┌──────────────┐
 │  GitHub repo    │      │  Postgres (managed,  │      │ Object store │
 │  registry JSON  │      │  e.g. Supabase)      │      │ (R2/S3)      │
 │  dossiers,      │      │  corpora, tags,      │      │ screenshots, │
 │  schema,        │      │  effects, candidate  │      │ flow dumps,  │
 │  decision log   │      │  queue               │      │ html         │
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
 │  reads: repo files (registry, statuses,      │
 │  Actions logs) + Postgres API (effects,      │
 │  corpora) when those exist                   │
 └──────────────────────────────────────────────┘
```

## Where the engine runs

In the solo phase the "engine" is not a service but a set of pipelines. All of them live in **GitHub Actions**:
- **Validator** — on every commit to /registry: a record without metrics/constraints does not pass.
- **Card generator** — on every merge: cards regenerate from JSON.
- **Derivation pipeline** — scheduled and manual (workflow_dispatch): mining meta-analyses → dossier drafts → candidate queue.
- **Corpus tagging** — batches on demand.

Why Actions and not a server: every run is an open log with full output. The "no black box" requirement is satisfied by the platform itself: open the Actions tab and see what ran, when, and with what result. Limits (6h per job) suffice for our batches; if a batch outgrows them, it moves to the harvest worker without changing the scheme.

**Runtime selection** (the mechanism filter at generation time) is a local script during the solo phase for M3 runs. In August it moves **inside Ventora's backend** as a pure function — the registry is baked into the build from git. A separate "engine server" does not exist by design: the engine is a layer of Ventora, not an island.

## Where the data lives

Three tiers by data type:

| Tier | What | Where | Why |
|---|---|---|---|
| Knowledge | mechanism registry, dossiers, schema, decision log | **GitHub repo (private)** | versioning, review, status history = git history |
| Structure | corpora (tagged flows, reviews→labels), effects table, candidate queue | **managed Postgres** (when corpora arrive) | SQL joins for the loop, instant REST API for the showcase, pgvector inside — when embeddings are needed, same DB |
| Raw | interface screenshots, flow recordings, html dumps | **object store (R2/S3)** | no egress fees, pennies per TB |

Boundary rule: anything a human edits and reviews — git. Anything pipelines produce by the thousands — Postgres. Anything binary — object store.

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
- Enough observed_effects → learned ranking replaces manual weights.

## What matters for the August handoff

The team receives a system where: the core is in git (review via PR), pipelines are in Actions (open logs), data is in Postgres (SQL access for everyone), and the single product integration point is one selection function inside Ventora's backend. Nothing exotic to maintain.
