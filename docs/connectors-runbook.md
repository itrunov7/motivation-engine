# Connectors runbook — operating and extending the fleet

This is the operator's manual for the Motivation Engine's source connectors. It
is written for a non-technical owner and for the August team. If you read only
this document, you should be able to run the fleet day to day, understand every
status pill, keep the budget safe, and add a new connector without breaking
anything.

The test this document holds itself to: **a new team member can operate and
extend the fleet from this page alone.** Every number below (caps, cadences,
thresholds) is copied from a real config file, and each is labelled with the
file that owns the truth — so when a number changes, you know exactly where it
lives and this page is never the authority that drifts.

One idea to hold onto before anything else: **connectors harvest; CI guards.**
Harvesting reaches out to public APIs and writes data into the repo. Guarding
(the checks that run on every code push) never fetches anything — it only
verifies that the data and the manifests are well-formed. These are two
different worlds. This runbook keeps them apart on purpose.

---

## 1. How runs happen

There are exactly **two ways a harvest run happens.** Neither of them is "on
push" — pushing code never harvests (see section 6 for what push *does* do).

### Path A — the schedule (hands-off)

[`.github/workflows/connectors.yml`](.github/workflows/connectors.yml) owns every
scheduled job (D-030). It runs on GitHub's clock, no human involved:

- a **heartbeat** every 6 hours (checks each API is alive — not a harvest),
- an **evidence** harvest every Monday at 05:00 UTC,
- a **wayback** harvest on the 1st of each month at 06:00 UTC.

The schedule firing does **not** mean a run actually happens. A gate
(`tools/ops-gate.ts plan`) decides what is genuinely due and skips the rest,
writing the reason for every skip into the run's job summary. A run is skipped
when the connector is paused, when its cadence hasn't elapsed yet, when the
target's registry record hasn't changed in the last 7 days, when the API is
currently down, or when it would exceed the budget. So a "nothing happened this
week" run is normal and healthy, not a failure.

### Path B — the Run button on `/ops` (deliberate, with a quote first)

When you want to harvest something now, open `/ops` and press **Run** on a
connector. The app never harvests directly — it asks GitHub to do it (D-023,
D-025). The flow is:

1. **Dry-run quote.** The app dispatches
   [`harvest.yml`](.github/workflows/harvest.yml) with `dry_run=true`. This makes
   **zero** harvesting API calls; it just computes a deterministic estimate.
2. **Confirmation screen.** You see the quote — how many API calls, how many
   records, roughly how long, and estimated cost — next to the month-to-date
   budget.
3. **Confirm → real run.** Only after you confirm does the app dispatch
   `harvest.yml` again with `dry_run=false`, and the actual harvest runs.

The app's entire job is to *trigger* the workflow. GitHub runs the connector.

If the dry run **fails** (rather than succeeding with no data), `/ops` now says
so explicitly — it shows *which step* broke and links the run — instead of a
generic "no estimate" message. A blank estimate and a failed estimate are
different things, and the console tells them apart (D-025).

### Acceptance check: the Run → quote → confirm loop

Run this end-to-end whenever the quote path, the harvest workflow, or the ops
server actions change. It also re-verifies cost accounting and Semantic Scholar
rate compliance in one pass.

Preconditions: `/ops` is deployed with `GH_OPS_TOKEN` + `GH_OPS_REPO` set (the
write/run surface is enabled, not read-only), and the repo secret `S2_API_KEY`
is configured (the real run uses it; the dry-run quote does not).

1. On `/ops`, press **Run** on `evidence` with target `LA-01`.
2. Within ~60s a **quote** appears with realistic figures — for `LA-01`,
   ~20 API calls, ~332 records, `$0.00` — next to the month-to-date budget. The
   estimate header **names the target it priced** (e.g. "estimate — LA-01");
   confirm only that it matches the target you selected.
   - If instead you see **"The estimate run failed: …"**, open the linked run,
     read the named step, fix that cause, and re-run. (You should *not* see the
     old catch-all "no estimate" message for a real failure.)
3. Press **Confirm & run**. The real harvest dispatches against the quoted
   target — not a re-read of the dropdown.
4. When it finishes, open the connectors page (or the evidence manifest): the
   last run's **api_calls** is a realistic non-zero number (verifies cost
   accounting, D-022), and there is **no `s2_throttled` warning** and no
   `HTTP 429` in the harvest log (verifies the S2 key + the global 1-rps queue
   under load, D-027).

The quote step is deterministic and makes zero network calls, so step 2 can
also be smoke-tested locally without the app:
`npx tsx tools/run-connector.ts quote evidence mechanism=LA-01 raise_cap=false`
should print the same estimate JSON.

> **Regression watch — the selector must dispatch what it shows (D-039).** On
> 2026-07-15 the Run Now selector showed `HA-04` but dispatched `EN-03`, and
> reset to `EN-03` after the run. Cause: the selected target lived in React
> state initialized once to the first target; when the connector's targets list
> was edited under it, the controlled `<select>` painted its first option while
> state kept the stale value, so the dispatch used the invisible stale target.
> The fix reconciles the displayed value with the live targets list, locks the
> **quoted** target through Confirm (the estimate is the single source of truth
> for the real run), and names the target in the estimate header. When you touch
> the selector, the quote path, or the ops server actions, re-run the acceptance
> check above and confirm the estimate header names the target you picked before
> pressing Confirm.
>
> **Why it persisted after the first fix (D-040).** `/ops` writes config to
> GitHub but originally *read* it from the deploy-time filesystem snapshot, so a
> just-saved targets list stayed invisible until the next redeploy and the Run
> selector kept defaulting to the stale first target. The console now reads the
> live `_ops` config from GitHub on load (a read-only server action, same
> allowlist as the write path), so the selector reflects committed targets
> immediately — no redeploy or hard reload needed. If you ever see the selector
> lag a save, that live read failed: check `GH_OPS_TOKEN`/`GH_OPS_REPO`.
>
> **Loading gate (D-041).** Because the page first renders from the deployment
> snapshot and then reads the live config, the console holds the connector cards
> behind a brief "loading current settings…" state until that live read lands —
> so you never see the snapshot flash as if it were saved. If the live read
> fails you get an explicit error with a **Retry** button rather than a silently
> stale copy. The settings on screen are always the committed ones, a short
> loading state, or an honest error — never a stale guess.

### The operator's contract: watch issues, not logs

You are **not** expected to read GitHub Actions logs. When something fails for
real, the automation opens a GitHub **issue** for you (labelled `ops`, D-022).

- Green issue tracker = healthy fleet. Nothing to do.
- An open `ops` issue = something needs you. Read it, fix the cause, then
  **close the issue** — closing it re-arms the automation so a repeat failure
  will open a fresh one.

That's the whole daily loop: glance at issues, not logs.

---

## 2. The two status axes

Every source shows two independent pills. They answer different questions, and
confusing them is the most common operator mistake.

| Axis | Question it answers | Where it comes from |
|------|---------------------|---------------------|
| **Connection** | "Have we set this source up?" | The corpus manifests on disk (D-026) |
| **Health** | "Is the API answering right now?" | The heartbeat file (D-021) |

**Connection** is *connected* the moment a manifest lists the source in its
`source_ids` — meaning a connector was built and has run at least once. It does
**not** care whether that last run went perfectly. A source stays
*not_connected* only while no manifest mentions it (the connector was never
built or never run). Truth lives in `/corpora/{dir}/manifest.json`.

**Health** comes only from
[`corpora/_health/heartbeat.json`](corpora/_health/heartbeat.json), refreshed by
the 6-hourly heartbeat. A heartbeat older than **12 hours** reads as `unknown`,
never as `ok` — a silent monitor is not a healthy monitor.

### The four combinations and what to do

| Connection | Health | What it means | What you do |
|------------|--------|---------------|-------------|
| connected | ok | Set up and the API is answering. | Nothing. This is the happy path. |
| connected | degraded | Set up, but the API is throttling us (HTTP 429). | Check `S2_API_KEY` is set and we're within rate limits. Runs still work, just slower. |
| connected | down | Set up, but the API is unreachable right now. | Wait — it's a transient outage. Your harvested corpus on disk is untouched. |
| not_connected | ok | The API is fine, but no connector has run yet. | Build/run the connector (section 8). Nothing is broken; it just hasn't started. |

Two edge readings you'll also see:

- **`unknown` health** — the heartbeat is stale or missing. Run `npm run health`
  (or wait for the next 6-hourly tick) to refresh it.
- **`n_a` health** — an internal source with no external endpoint by design;
  there is nothing to probe.

### Don't confuse either axis with "last run"

There is a **third, separate signal** shown on `/ops` and `/connectors`: the
quality of the *last run* — `success`, `partial`, or `failed`. A `partial` run
(for example, Semantic Scholar throttled us) does **not** flip Connection back
to not_connected (D-026). Connection = "is it set up", health = "is the API up
now", last run = "how did the most recent harvest go". Three questions, three
signals. Read them separately.

---

## 3. The budget model

The fleet is deliberately cheap and deliberately capped. Two layers of limits,
both stored as data (D-024), never hidden in code:

| Limit | File | Current value |
|-------|------|---------------|
| Monthly cap (USD) | [`corpora/_ops/budget.json`](corpora/_ops/budget.json) | `$5` |
| Monthly cap (API calls) | [`corpora/_ops/budget.json`](corpora/_ops/budget.json) | `20000` |
| Per-run limit (evidence) | [`corpora/_ops/connectors/evidence.json`](corpora/_ops/connectors/evidence.json) | `150` calls / `5000` records |
| Per-run limit (wayback) | [`corpora/_ops/connectors/wayback.json`](corpora/_ops/connectors/wayback.json) | `40` calls / `2000` records |

The whitelisted APIs are all free, so `estimated_usd` computes to `0` today; the
USD cap is a guardrail for the day a priced job ever exists (D-022).

**Month-to-date usage** is the sum of every manifest's `cost` block for the
current UTC calendar month — computed from real run history, nothing hardcoded.

**Dry-run quotes** (section 1, Path B) estimate a run's cost *before* it happens,
deterministically and with no network calls, so you always confirm against real
numbers.

### The override flow

When a quoted run would exceed the **monthly** budget, the confirmation screen
shows a checkbox: *"raise the cap for this one run."* Ticking it:

1. appends an append-only entry to
   [`decisions/decisions.json`](decisions/decisions.json) **before** the run is
   dispatched — so the audit trail never lags the action (D-023), and
2. passes `raise_cap=true` to the workflow, which bypasses **only** the monthly
   budget gate.

`raise_cap` **never** bypasses the per-run call/record limits — those are
enforced again mid-run at the fetch layer (D-027), and the scheduler never
passes `raise_cap` at all.

### The one budget rule to remember

Big deliberate harvests mean you **raise the caps**, never remove them. If you
know you're about to do a large legitimate harvest, edit the caps in
`corpora/_ops/*` (in git, or via the `/ops` form) to a higher explicit number.
A cap of "unlimited" is not a cap — the point is that the ceiling is always a
real, reviewable number.

---

## 4. Cadence per source

Cadence lives in two layers: GitHub cron says *when the workflow fires*, and
`_ops` `cadence.every_days` says *the minimum gap before a run is allowed*. A run
happens only when both agree it's due.

| Connector | Sources harvested | Cron (`connectors.yml`) | `every_days` gate | Notes |
|-----------|-------------------|-------------------------|-------------------|-------|
| heartbeat | all probeable APIs | `0 */6 * * *` (every 6h) | — | Health probe, not a harvest |
| evidence | `openalex`, `semantic-scholar` | `0 5 * * 1` (Mon 05:00 UTC) | `7` | Plus a 7-day registry-freshness filter on each target |
| wayback | `wayback-cdx` | `0 6 1 * *` (1st, 06:00 UTC) | `90` | Monthly cron is the ceiling; the 90-day gate is the real spacing |
| dummy | — | not scheduled | — | Paused smoke test, run by hand only |

`pubmed-europepmc` is **health-probed only** — there is no PubMed harvester yet,
so it shows a health pill but never a harvest run.

### The Semantic Scholar hard rule (1 rps cumulative, D-027)

Semantic Scholar's key allows **1 request per second, cumulative across all
endpoints** — search, paper details, references, and the health probe all draw
from the same one-per-second allowance. This is enforced structurally, not by
discipline:

- **Every** S2 call goes through a single shared queue in
  [`tools/connectors/lib/http.ts`](tools/connectors/lib/http.ts) that spaces
  requests at ≥1100 ms. The rule for any future code: no S2 call outside that
  queue.
- Both workflows share the `connectors-s2` concurrency group, so two runner
  processes can never hit S2 at the same time.
- **Snowballing uses OpenAlex, not S2.** Reference expansion walks OpenAlex's
  `referenced_works` — the same citation graph without the 1 rps ceiling — so it
  adds *zero* S2 load by design.

---

## 5. Evidence corpus rules

The evidence connector turns a mechanism's search terms into a structured,
completeness-checked corpus. The rules that keep that corpus honest:

- **Terms live in the mechanism record.** Each mechanism carries
  `evidence_terms` (D-015) — the connector reads them from the registry record,
  not from any connector-side list. No terms → it falls back to the mechanism
  name.
- **`pinned_evidence` is the human-added tail** (D-017). These are papers the
  owner pins by hand — the important ones a keyword search won't surface. The
  connector always includes them.
- **The five-category checklist** (D-019): every record is classified, on
  metadata only, into `foundational`, `meta-analysis`, `replication`, `dissent`,
  and `recent`. The connector never judges scientific content — only counts.
- **Empty dissent blocks a dossier.** The validator's `checkDossierDissent`
  fails any dossier whose mechanism corpus has `dissent` count `0` (or is
  missing/unclassified). A corpus that can only *confirm* is treated as broken —
  this is a hard gate, not a warning.
- **Digests are committed artifacts of the hand-off, not throwaway local files.**
  The `npm run digest` output under `corpora/evidence/digests/{id}.md` (D-065) is
  the ~2-page projection an author reads to write the record + dossier; it is
  versioned in git alongside the corpus it summarizes so the harvest→authoring
  trail is auditable. Regenerating a digest is deterministic (its timestamps come
  from the corpus, not wall-clock), so a re-run over an unchanged corpus produces
  a byte-identical file and no diff.
- **Review-reference coverage.** For the top reviews, their references are
  resolved via OpenAlex and the coverage ratio is written into
  `coverage_report`; any reference cited by ≥2 reviews but missing from the
  corpus is auto-added with `source_api: "snowball"`.
- **Diversity, not volume** (D-058). Each term fans out across viewpoints — a
  `canon` query (most-cited / relevance), a `recent` query (OpenAlex by date so
  newer product forms aren't starved), and five contrast angles (`application`,
  `critique`, `replication`, `boundary`, `cross-domain`) whose suffixes are
  generic academic vocabulary, never science. The contrast angles alternate
  OpenAlex / Semantic Scholar so a run draws across both sources. Every harvest
  writes a `diversity_report` (viewpoint spread, source spread, recency, novelty
  rate) into the corpus file.
- **Novelty gate — re-fetching canon is not progress** (D-058). After dedupe,
  the harvest's unique records are checked against the *previous* corpus. When
  more than 80% were already on disk the run sets `low_novelty: true` in the
  `diversity_report` and emits `warnings.low_novelty` in the manifest; the
  corpus is still written (honest data) but the maturation loop does **not**
  count it as progress. The gap planner skips a queued task whose mechanism's
  last harvest with the *same terms* came back low-novelty (counted as
  `low_novelty_skipped` in `research-queue.json`) — change the terms or the
  segment qualifier to re-enable it.
- **Saturation-driven depth** (D-080). Evidence v3 walks a deterministic
  breadth-first frontier of owner-authored terms × viewpoints × ranking
  buckets. Relevance, recency, and citation retrieval receive balanced shares;
  OpenAlex backward references and forward citations are inserted only from
  records that pass the metadata-only topical gate. The run stops when rolling
  novelty over the configured K-query window falls below threshold, or a
  configured call/record cap stops it. `saturation_report` records every point
  on the novelty curve, the stop reason, and the topical-confirmation rate.
- **Checkpoint/resume** (D-080). The connector atomically checkpoints after
  each configured query interval. It exits before the six-hour Actions ceiling,
  the workflow commits that operational checkpoint, and a queued continuation
  resumes the same logical call budget. An unfinished slice is not maturation
  progress.
- **Storage gate is active.** The 1,000-unique-record evidence cap is the
  current git-tier boundary. The requested full-depth harvest would produce
  thousands of rows, so the architecture escalation trigger fired as designed:
  migrate corpus storage first, then raise this cap. Do not route around it.

---

## 6. Data hygiene and the guard layer

### The 40 MB guardrail → Postgres

A single corpus directory may not exceed **40 MB** (`MAX_CORPUS_BYTES` in
[`tools/connectors/lib/io.ts`](tools/connectors/lib/io.ts)). Hitting it is not a
bug to work around — it is the **Postgres escalation trigger** described in
[`docs/architecture.md`](docs/architecture.md). When a corpus genuinely needs to
grow past 40 MB, that is the signal to move it out of git into a database, not to
raise the limit.

### No raw HTML in git

Connectors store **references, not page contents.** The wayback connector, for
example, stores only the CDX index — URLs and capture dates — never the archived
HTML (D-028). Downloading full pages would blow the 40 MB guardrail immediately;
binary and HTML dumps belong in object storage when that phase arrives.

### Push CI is a guard, not a harvester

Every code push triggers
[`.github/workflows/validate.yml`](.github/workflows/validate.yml), which runs
`npm run validate` and `npm run build`. This checks the knowledge files and the
manifest contracts — it **never fetches anything from any API.** This is why
"three ways runs happen" is the wrong mental model: push CI *guards* the data,
the two paths in section 1 *harvest* it. Keep the two apart.

---

## 7. Failure policy

- **Retry once, then open an issue.** A failed run is retried a single time after
  a 60-second backoff. If it fails again, the automation opens (or confirms) a
  GitHub issue titled `connector:{id} failing`, labelled `ops`, and fails the job
  red (D-022).
- **One issue per problem.** Deduplication is by exact title — while one
  `connector:evidence failing` issue is open, a repeat failure will **not** open
  a second one. Close the issue after the fix to re-arm the automation.
- **A budget stop is not a failure.** If a run hits its per-run call cap
  mid-flight, it stops gracefully: the run is recorded as `partial` with
  `warnings.capped`, and the job exits green (D-027). That's the safety net
  working, not an error.

---

## 8. Checklist: adding a new connector

Follow these in order. Each step is a real wiring point in the repo; skipping one
is what breaks a new connector.

1. **Implement the `Connector` interface** in `tools/connectors/{id}.ts`,
   including a `quote()` method (so the dry-run flow works). Only the four
   whitelisted APIs are allowed —
   `api.openalex.org`, `api.semanticscholar.org`,
   `eutils.ncbi.nlm.nih.gov`, `web.archive.org` (D-011). Any other endpoint
   needs its **own decision entry first.**
2. **Register it in two places:** add it to `CONNECTORS` in
   [`tools/connectors/index.ts`](tools/connectors/index.ts) **and** to
   `KNOWN_CONNECTOR_IDS` in [`lib/ops.ts`](lib/ops.ts). The validator fails CI if
   these two drift apart.
3. **First run writes the manifest** at `/corpora/{sourceId}/manifest.json`, with
   `source_ids` and a `cost` block. This is what flips the source to *connected*.
4. **Add its ops config:** `corpora/_ops/connectors/{id}.json` with `paused`,
   `cadence.every_days`, `limits`, and `targets`. The filename must equal the
   `connector_id`, which must be a registered connector, or CI fails.
5. **Add a schedule** — a cron line and its routing in
   [`.github/workflows/connectors.yml`](.github/workflows/connectors.yml) — if the
   connector should run on a clock.
6. **It appears on the `/ops` cockpit automatically.** No UI code to touch; the
   cockpit is driven by the registered connectors and their `_ops` config.
7. **Add or update the `sources.json` entry** with the right `connection_mode`
   (usually `api`) so the source board knows about it.
8. **Add a decision entry** to `decisions/decisions.json` recording the new
   connector.

---

## 9. Segment evolution — growing the product-segment axis (D-054)

The columns of the sufficiency matrix are the **product segments** in
[`segments/segments.yaml`](segments/segments.yaml) (D-047). That list is a
**seed, not a fixed set** — it grows two ways.

### Path A — the owner adds a segment now (available today)

To add a segment, make **one edit**: append an entry to `segments.yaml` with
`provenance: owner` (git-only — there is no UI write surface for the axis).

```yaml
  - id: ai-agent-tools
    group: form
    definition: Products whose core surface is an autonomous or assistive AI agent acting on the user's behalf.
    status: active
    provenance: owner
```

What happens on the **next analyzer run** (`npm run analyze`, or the weekly
maturation loop, D-052), with **no further configuration**:

1. The segment appears in the matrix as a new column, scored **all-red** — every
   `pack × new-segment` cell is 0 on all five criteria, status red,
   `segment_evidence: general_only`. This is honest: nothing has been
   demonstrated *for this segment* yet, so red is the truth, not a bug. The
   analyzer prints `· segment "…" unconfigured — enters the matrix all-red`.
2. `npm run gaps` (D-051) ranks those all-red cells to the **top** of the
   research queue (max gap size), deriving the harvest qualifier from the
   segment id (`ai-agent-tools` → `"ai agent tools"`) so the tasks are targeted
   even before you hand-tune anything. It prints `· segment "…" unconfigured —
   qualifier derived from id`.
3. The maturation loop harvests against those tasks, and the segment starts
   maturing like any other — red → green flips still require the owner to
   upgrade registry grades/dossiers (rule 8), same as everywhere.

**Graduating a segment from bootstrap to configured.** When you want the segment
scored on real product judgment instead of all-red, add it to the hand-authored
[`analysis/analyzer.config.yaml`](analysis/analyzer.config.yaml):

- `segment_stages.{id}` — the funnel stages this segment type typically lives on
  (**required** to leave bootstrap; this is what makes the cells score on the
  five criteria instead of a flat red).
- `segment_affinity.{id}` — optional per-mechanism boosts marking which
  mechanisms are load-bearing for the segment (presence flips cells from
  `general_only` to `segment_specific`).
- `gap_planner.segment_qualifiers.{id}` and `gap_planner.segment_weights.{id}` —
  optional, to override the id-derived qualifier and set harvest priority.

A **configured** segment (one with a `segment_stages` entry) that is missing a
qualifier still **fails loudly** — the bootstrap fallback applies only to
brand-new, unconfigured segments, so a typo in a real config is never silently
swallowed.

### Path B — analyzer-suggested candidates (designed, not scheduled yet)

[`tools/segment-suggest.ts`](tools/segment-suggest.ts) (`npm run segment-suggest`)
is the discovery analog for segments — the counterpart of the mechanism seed
stubs. Its **design is committed but it is inert**: it reads nothing, writes
nothing, and is on **no schedule and in no workflow**. Running it today just
prints `designed, not scheduled — no candidates written`.

The intended future behavior (see the file's header): read the harvested
corpora (`corpora/evidence`, `corpora/benchmarks`, `corpora/wayback`) for
recurring product-context clusters that **no existing segment covers**, and
propose them as candidates appended to
[`segments/candidates.json`](segments/candidates.json)
(`{ version, generated_at, candidates[] }`, each `{ id, group,
definition_draft, evidence_note, proposed_at, status }`) for **owner approval**.
Approving a candidate means hand-adding it to `segments.yaml` with
`provenance: analyzer` — after which it enters the matrix all-red via Path A and
matures through the loop. The tool never edits `segments.yaml` and never invents
science; it only surfaces vocabulary the corpus already contains. Switching it
on is a future decision with its own `decisions.json` entry.

The `/maturation` cockpit's "Segments are evolving" panel shows the candidate
count (0 today) read from `candidates.json` — never hardcoded.

---

## 10. Licensing — manual sources are never machine-harvested

Some sources are licensed for human curation only. In
[`sources/sources.json`](sources/sources.json) these carry
`connection_mode: "manual"` (11 sources today, e.g. `mobbin`). They are **never**
machine-harvested — no connector, no scheduled run, no scraper. Their content
enters the system only through human curation, per each source's licensing terms.
The `access` and licensing fields in `sources.json` are the source of truth for
what may and may not be fetched; when in doubt, a `manual` source stays manual.

---

## Quick operator reference

| I want to… | Do this |
|------------|---------|
| See fleet status | Open `/ops` and `/connectors` |
| Run a harvest now | `/ops` → Run → review quote → Confirm |
| Refresh health pills | `npm run health` (or wait for the 6-hourly tick) |
| Know if something needs me | Check open GitHub issues labelled `ops` |
| Raise the budget for a big harvest | Edit caps in `corpora/_ops/*` (git or `/ops` form) |
| Add a new connector | Follow section 8 |

Remember the two anchors: **connectors harvest, CI guards**, and **watch issues,
not logs.**
