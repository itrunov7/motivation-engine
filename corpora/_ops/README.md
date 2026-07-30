# /corpora/_ops — Operational config (D-024)

The fleet's operating parameters, as versioned data. This is the ONLY part of
`/corpora` the app can write: the `/ops` page commits here through a
fine-grained GitHub token via a server-action write path with a hard path
allowlist (D-023). Knowledge files (registry, dossiers, docs, sources,
decisions) stay read-only in the UI and are edited only in git.

`_ops` is `_`-prefixed, so the showcase corpus scan ignores it exactly like
`_health` and `_dummy` — it is config, not a harvested corpus.

## Files

### `budget.json`

```jsonc
{
  "monthly_caps": {
    "usd": 5,        // dollar ceiling for the calendar month (guards future priced jobs)
    "calls": 20000   // outbound-API-call ceiling for the calendar month
  }
}
```

The scheduler stops starting new runs once month-to-date (rolled up from
manifests) would exceed a cap. Every D-011 API is free, so `usd` reads $0
today and guards only future LLM jobs; `calls` is the meaningful ceiling now.

### `connectors/{id}.json`

One file per registered connector; the filename stem must equal
`connector_id`.

```jsonc
{
  "connector_id": "evidence",
  "paused": false,
  "paused_reason": null,          // required (non-empty) when paused is true
  "cadence": { "every_days": 7 }, // a due target runs at most this often
  "limits": {
    "max_calls_per_run": 150,
    "max_records_per_run": 1000   // current git storage-tier ceiling
  },
  "saturation": {
    "window_queries": 10,
    "novelty_threshold": 0.05,
    "minimum_queries": 30,
    "records_per_query": 25,
    "retrieval_shares": { "relevance": 1, "recency": 1, "citation": 1 },
    "citation_graph": {
      "backward_references": true,
      "forward_citations": true,
      "max_anchors": 20
    },
    "checkpoint_every_queries": 1,
    "soft_time_limit_minutes": 300
  },
  "targets": ["LA-01"]            // what the machine harvests (mechanism ids)
}
```

- `targets` is the explicit harvest scope — what the owner pointed the machine
  at, not whatever files happen to exist. It defaults to every mechanism id
  with a full record in `/registry/mechanisms`. The scheduled run adds a
  freshness filter on top: a target is only harvested if its registry record
  changed in the last 7 days (checked with `git log`).
- `paused` connectors are skipped by the scheduled workflow, and the
  `paused_reason` is written to the job summary.
- `limits` are enforced as a pre-run ceiling against the deterministic quote
  (D-025), before any harvest call is made. `max_calls_per_run` is
  additionally enforced by the runner at the polite-fetch layer DURING the
  run, retries included (D-027) — a connector cannot opt out. For connectors
  that call Semantic Scholar, size it so a run stays within minutes even if
  every call were S2 at the 1 rps cumulative key allowance (100 S2 calls ≈
  2 min; evidence defaults to 150).
- Evidence uses `saturation` to stop only after the rolling novelty rate over
  the last 10 completed queries falls below 5% (after at least 30 queries), or
  a cap is reached. Retrieval is balanced across relevance, recency, and
  citation ordering. Both backward references and forward citations are
  expanded from metadata-confirmed on-topic records.
- `max_records_per_run: 1000` is intentionally the current git storage-tier
  gate (D-080), not the intended full-depth limit. Raise it only after the
  separately planned evidence-corpus storage migration.
- Multi-hour runs checkpoint after each query under
  `_ops/checkpoints/evidence/`. A soft five-hour slice exits green/partial;
  Actions commits the checkpoint and queues a continuation. Calls already
  spent remain part of the same logical-run cap.
- A checkpoint file is named `<mechanism>.<fingerprint-prefix>.json` (D-096).
  The fingerprint covers the mechanism, its terms, the saturation config, and
  the base corpus, so one mechanism harvested for several segments holds one
  independent slice per segment. An address with no file simply means "no
  resumable slice for these terms" and starts fresh; only a file whose
  contents disagree with their own address is treated as corrupt and stops the
  run for review.

## Validation (D-024)

`npm run validate` checks every `_ops` file with the SAME validators the
write path uses (`lib/ops.ts`), so the UI can never push a config that would
redden CI: required fields, non-negative numbers, filename = `connector_id`,
`connector_id` is a registered connector, and every `target` exists in
`/registry/mechanisms`. Malformed ops config fails the build rather than
silently misconfiguring the fleet.

## Run-with-quote flow (D-025)

Runs are triggered from `/ops`, never executed by the app. A dry-run dispatch
produces a deterministic `quote` (calls, records, duration, estimated_usd) as
an ephemeral run artifact — never committed. The operator confirms; if the
quote exceeds remaining budget, confirmation requires an explicit
"raise cap for this run" checkbox, which logs an override auto-entry to
`decisions.json`. See `.github/workflows/harvest.yml` and `tools/ops-gate.ts`.

## Environment (D-023)

The `/ops` write + run surface needs a fine-grained, repo-scoped GitHub token.
Set these on the deployment (never committed):

| Env var         | Required | Purpose                                                            |
| --------------- | -------- | ------------------------------------------------------------------ |
| `GH_OPS_TOKEN`  | yes      | Fine-grained PAT with **Contents: read/write** and **Actions: read/write** on this repo. Enables committing `_ops` and dispatching/reading `harvest.yml`. |
| `GH_OPS_REPO`   | yes\*    | `owner/repo` to target. Falls back to `GITHUB_REPOSITORY`.         |
| `GH_OPS_BRANCH` | no       | Branch to commit to and dispatch against (default `main`).         |

Without `GH_OPS_TOKEN`/`GH_OPS_REPO`, `/ops` renders **read-only**: current
settings and usage are visible, but every Save and Run control is disabled.
Auth is unchanged (D-006): the whole app, `/ops` included, sits behind the
single-password middleware. Harvest runs also read `S2_API_KEY` (secret) and
`CONNECTOR_MAILTO` (var) in the workflow, as `connectors.yml` does.
