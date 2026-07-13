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

There is no status field in this file. The showcase computes each source's
state from `/corpora/{source_id}/manifest.json` (written by connector runs,
contract in /corpora/README.md):

- an **api** or **internal** source is *connected* iff its manifest exists
  with `last_run.status = "success"`
- a **report** source is *ingested* iff additionally at least one
  `data_files` entry exists on disk
- **manual** and **deferred** sources show their mode — a connectivity
  status for them would be fake in either direction

## Filled by

Owner-provided source registry, ported during the data step. States change
only when a connector run actually writes a successful manifest.

## Phase

Registry file: July (baseline). Connectors: August–September (Phase 2).
