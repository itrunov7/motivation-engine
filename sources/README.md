# /sources — Data-source registry

## What lives here

`sources.json` — the registry of external data sources in four classes:

- **A — Interfaces** (Mobbin, ScreensDesign, Page Flows, paywall galleries, …)
- **B — Science** (OpenAlex, Semantic Scholar, PubMed, PsyArXiv/OSF, …)
- **C — Analytics & effect sizes** (RevenueCat, Baymard, GoodUI, benchmarks, …)
- **D — Non-obvious** (SEC EDGAR, Google Patents, FTC/EU enforcement, …)

Each source records access type, cost, priority (P0–P2), phase, connection
mode, which L-levels it feeds, and legal notes.

## Connection modes (D-013, D-016)

Sources differ by nature, so each carries a `connection_mode`:

- **api** — automated connector against a public API
- **internal** — data produced by our own platform, not an external source
- **report** — one-off ingested artifact (published report / dataset)
- **manual** — licensed human curation, never machine-harvested
- **deferred** — P2, not planned this phase (`mode_note` records why)

## Statuses are computed, never stored

There is no status field in this file. The showcase computes three
independent axes per source from files (contract in /corpora/README.md):

- **connection** — "is this source set up": an **api** or **internal**
  source is *connected* iff ANY `/corpora/{dir}/manifest.json` lists it in
  `source_ids` (D-026). A manifest only exists after a connector was built
  and run at least once, so its presence is the set-up proof — regardless
  of how that run went.
- **last run** — "is it working well": success / partial / failed from the
  newest `last_run` among manifests listing the source. Granularity is per
  corpus (D-020): sources sharing a corpus share its run status.
- **health** — "is the API accessible right now": from
  `/corpora/_health/heartbeat.json` (D-021); a heartbeat older than 12h
  renders as unknown, never as ok.
- a **report** source is *ingested* iff a manifest lists it AND at least
  one `data_files` entry exists on disk
- **manual** and **deferred** sources show their mode — a connectivity
  status for them would be fake in either direction

## Filled by

Owner-provided source registry, ported during the data step. States change
only when a connector run writes a manifest (connection / last run) or the
health check writes a heartbeat (health).

## Phase

Registry file: July (baseline). Connectors: August–September (Phase 2).
