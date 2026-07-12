# /sources — Data-source registry

## What lives here

`sources.json` — the registry of external data sources in four classes:

- **A — Interfaces** (Mobbin, ScreensDesign, Page Flows, paywall galleries, …)
- **B — Science** (OpenAlex, Semantic Scholar, PubMed, PsyArXiv/OSF, …)
- **C — Analytics & effect sizes** (RevenueCat, Baymard, GoodUI, benchmarks, …)
- **D — Non-obvious** (SEC EDGAR, Google Patents, FTC/EU enforcement, …)

Each source records access type, cost, priority (P0–P2), phase, status,
which L-levels it feeds, and legal notes. At baseline every status is
`not_connected` — that is the honest truth; no scrapers or connectors exist yet.

## Filled by

Owner-provided source registry, ported during the data step. Statuses change
only when a connector actually ships.

## Phase

Registry file: July (baseline). Connectors: out of scope for baseline.
