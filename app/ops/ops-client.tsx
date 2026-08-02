"use client";

/**
 * app/ops/ops-client.tsx — the interactive Operations console (D-023/D-025).
 *
 * Plain-language controls for a non-technical operator: no raw JSON anywhere.
 * Every mutation calls a server action in ./actions (the only path to
 * api.github.com). Type-only imports from lib/ops keep node:fs out of the
 * client bundle.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import type {
  BudgetSnapshot,
  ExtractionBudgetState,
  ExtractionOpsConfig,
  ExtractionPriceState,
  ExtractionRunSummary,
  OpsConnectorConfig,
  QuoteArtifact,
} from "@/lib/ops";
import type { ExtractionQuote, ScopeKind } from "@/tools/extract";
import {
  confirmExtractionRunAction,
  confirmRealRunAction,
  loadLiveConnectorConfigsAction,
  pollDryRunAction,
  pollExtractionQuoteAction,
  saveBudgetAction,
  saveConnectorConfigAction,
  startDryRunAction,
  startExtractionQuoteAction,
  type ExtractionPollResult,
  type PollResult,
} from "./actions";

// ---------- Shared props ----------

export interface LastRunView {
  status: "success" | "partial" | "failed" | "broken";
  timestamp: string;
  apiCalls: number | null;
  estimatedUsd: number | null;
  capped: boolean;
  error: string | null;
}

export interface ConnectorView {
  config: OpsConnectorConfig;
  lastRun: LastRunView | null;
}

/** A selectable evidence target resolved to its L0 parent node (D-071). */
export interface MechanismOption {
  id: string;
  name: string;
  /** L0 node id, e.g. "S1" … "S7". */
  parent: string;
  parentName: string;
  /** True for cross-cutting perception mechanisms (S7, D-062). */
  crossCutting: boolean;
}

export interface OpsClientProps {
  writeEnabled: boolean;
  budget: BudgetSnapshot;
  extraction: ExtractionOpsConfig | null;
  extractionBudgetState: ExtractionBudgetState | null;
  extractionRun: ExtractionRunSummary | null;
  extractionPriceState: ExtractionPriceState;
  connectors: ConnectorView[];
  mechanismOptions: MechanismOption[];
  packOptions: string[];
  segmentOptions: string[];
  effectOptions: string[];
}

function ExtractionRunPanel({ run }: { run: ExtractionRunSummary | null }) {
  const outcomes = run
    ? [
        ["proposed", run.proposed],
        ["merged", run.merged],
        ["dropped ungrounded", run.droppedUngrounded],
        ["failed validation", run.failedValidation],
        ["held low confidence", run.heldLowConfidence],
        ["dropped at volume cap", run.droppedVolumeCap],
        ["high-confidence overflow", run.droppedVolumeCapHighConfidence],
      ]
    : [];
  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <h2 className="font-display text-lg font-medium text-[#E6EFE8]">
        Extraction quality gates
      </h2>
      {run ? (
        <>
          <p className="mt-1 text-xs text-[#8CA495]">
            {formatTimestamp(run.timestamp)} · {run.mode} · {run.scope}
          </p>
          <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">
            funnel: {run.recordsEligible} eligible → {run.recordsRelevant} passed
            pre-filter → {run.recordsProcessed} sent to model · {run.candidates}{" "}
            candidates · {run.recordsRemaining} remaining
          </p>
          {/* D-103: the token cap enforces itself by truncating the plan, so a
              run that answered a smaller question must say so out loud. */}
          <p className="mt-1 font-mono text-[11px] text-[#7C93A8]">
            {run.recordsDroppedTruncation === null || run.recordsSelected === null
              ? "token cap: truncation not reported — this run predates the counter (D-103)"
              : `token cap: ${run.recordsSelected} records kept by the planner · ${run.recordsDroppedTruncation} dropped to fit per_run_tokens`}
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            {outcomes.map(([label, value]) => (
              <div key={label} className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
                <dt className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
                  {label}
                </dt>
                <dd className="mt-1 font-mono text-lg text-[#E6EFE8]">
                  {value ?? "—"}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-[#8CA495]">
            High-confidence overflow counts capped items at or above 80%; raise the
            per-mechanism cap or rerun if that number is non-zero.
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-[#8CA495]">
          No extraction run yet. Gate outcomes will appear after the Actions extraction
          pipeline writes corpora/extraction/manifest.json.
        </p>
      )}
    </section>
  );
}

/** Options grouped under their L0 node, node order preserved from the input. */
interface NodeGroup {
  parent: string;
  parentName: string;
  crossCutting: boolean;
  options: MechanismOption[];
}

/** A node heading label, e.g. "S7 · Perception & comprehension (cross-cutting)". */
function nodeHeading(group: Pick<NodeGroup, "parent" | "parentName" | "crossCutting">): string {
  return `${group.parent} · ${group.parentName}${group.crossCutting ? " (cross-cutting)" : ""}`;
}

/**
 * Groups the given mechanism ids under their L0 node using `optionById`, in the
 * node order of `optionOrder` (already sorted parent-then-id upstream). Ids with
 * no known option fall into a trailing "unknown" group so a hand-typed target
 * is never silently dropped.
 */
function groupIdsByNode(
  ids: string[],
  optionById: Map<string, MechanismOption>,
  optionOrder: MechanismOption[],
): NodeGroup[] {
  const wanted = new Set(ids);
  const groups: NodeGroup[] = [];
  const byParent = new Map<string, NodeGroup>();

  for (const option of optionOrder) {
    if (!wanted.has(option.id)) continue;
    let group = byParent.get(option.parent);
    if (!group) {
      group = {
        parent: option.parent,
        parentName: option.parentName,
        crossCutting: option.crossCutting,
        options: [],
      };
      byParent.set(option.parent, group);
      groups.push(group);
    }
    group.options.push(option);
  }

  const unknown = ids
    .filter((id) => !optionById.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map(
      (id): MechanismOption => ({
        id,
        name: id,
        parent: "?",
        parentName: "not in registry",
        crossCutting: false,
      }),
    );
  if (unknown.length > 0) {
    groups.push({
      parent: "?",
      parentName: "not in registry",
      crossCutting: false,
      options: unknown,
    });
  }
  return groups;
}

// ---------- Presentation helpers (no status literals leak to knowledge) ----------

const C = {
  panel: "#151F1A",
  border: "#243329",
  inner: "#1A2620",
  accent: "#34D399",
  amber: "#E4B54E",
  slate: "#7C93A8",
  muted: "#8CA495",
  text: "#E6EFE8",
  alert: "#F87171",
};

const RUN_COLOR: Record<LastRunView["status"], string> = {
  success: C.accent,
  partial: C.amber,
  failed: C.alert,
  // D-132: the candidate ledger did not balance, so this run's counters are
  // unsound rather than merely incomplete.
  broken: C.alert,
};

/** Cadence in words — a client copy of lib/ops.describeCadence (lib/ops pulls
 *  node:fs and cannot be bundled here). Kept trivial to avoid drift. */
function describeCadence(everyDays: number): string {
  if (everyDays <= 1) return "about once a day";
  if (everyDays === 7) return "about once a week";
  if (everyDays === 14) return "about once every two weeks";
  if (everyDays >= 28 && everyDays <= 31) return "about once a month";
  return `about once every ${everyDays} days`;
}

function formatUsd(usd: number): string {
  return usd === 0 ? "$0.00" : `$${usd.toFixed(2)}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function pct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}

// ---------- Small inputs ----------

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
        {label}
      </span>
      {children}
      <span className="text-[11px] leading-snug text-[#8CA495]">{help}</span>
    </label>
  );
}

function numberInputClass(disabled: boolean): string {
  return `w-full rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-sm text-[#E6EFE8] outline-none focus:border-[#34D399] ${disabled ? "opacity-50" : ""}`;
}

function ProgressBar({ used, cap, unit }: { used: number; cap: number; unit: string }) {
  const p = pct(used, cap);
  const over = used > cap;
  const color = over ? C.alert : p >= 80 ? C.amber : C.accent;
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-xs text-[#8CA495]">
        <span style={{ color }}>
          {used} / {cap} {unit}
        </span>
        <span>{p}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[#0E1512]">
        <div className="h-full rounded-full" style={{ width: `${p}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "err"; children: React.ReactNode }) {
  const color = tone === "ok" ? C.accent : tone === "warn" ? C.amber : C.alert;
  return (
    <p className="mt-2 text-xs leading-relaxed" style={{ color }}>
      {children}
    </p>
  );
}

// ---------- Budget panel ----------

function BudgetPanel({
  writeEnabled,
  budget,
  extraction,
  extractionBudgetState,
  extractionPriceState,
}: {
  writeEnabled: boolean;
  budget: BudgetSnapshot;
  extraction: ExtractionOpsConfig | null;
  extractionBudgetState: ExtractionBudgetState | null;
  extractionPriceState: ExtractionPriceState;
}) {
  const [usd, setUsd] = useState(budget.caps.usd);
  const [calls, setCalls] = useState(budget.caps.calls);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const save = useCallback(() => {
    setMsg(null);
    start(async () => {
      const res = await saveBudgetAction({ usd, calls });
      setMsg(res.ok ? { tone: "ok", text: "Saved. Applies to the next run; the numbers above refresh on the next deploy." } : { tone: "err", text: res.error });
    });
  }, [usd, calls]);

  const dirty = usd !== budget.caps.usd || calls !== budget.caps.calls;

  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <header>
        <h2 className="font-display text-lg font-medium text-[#E6EFE8]">Monthly budget</h2>
        <p className="mt-1 text-sm text-[#8CA495]">
          The ceiling the fleet respects before starting a run this month ({budget.month} UTC).
          Usage is counted from real run costs — it is not a guess. Harvest APIs and paid
          OpenRouter extraction share these ceilings.
        </p>
      </header>

      {extractionBudgetState && (
        <div
          className="mt-4 rounded-md border px-4 py-3"
          style={{
            borderColor:
              extractionBudgetState.tone === "ok"
                ? `${C.accent}55`
                : extractionBudgetState.tone === "warn"
                  ? `${C.amber}55`
                  : `${C.alert}55`,
            backgroundColor:
              extractionBudgetState.tone === "ok"
                ? `${C.accent}0D`
                : extractionBudgetState.tone === "warn"
                  ? `${C.amber}0D`
                  : `${C.alert}0D`,
          }}
        >
          <p
            className="font-mono text-[10px] uppercase tracking-widest"
            style={{
              color:
                extractionBudgetState.tone === "ok"
                  ? C.accent
                  : extractionBudgetState.tone === "warn"
                    ? C.amber
                    : C.alert,
            }}
          >
            {extractionBudgetState.label}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#C7D7CC]">
            {extractionBudgetState.message}
          </p>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-[#243329] bg-[#1A2620] p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            calls used this month
          </p>
          <div className="mt-2">
            <ProgressBar used={budget.used.calls} cap={budget.caps.calls} unit="calls" />
          </div>
        </div>
        <div className="rounded-md border border-[#243329] bg-[#1A2620] p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            spend used this month
          </p>
          <div className="mt-2">
            <ProgressBar used={budget.used.usd} cap={budget.caps.usd} unit="usd" />
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-[#243329] bg-[#1A2620] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            extraction tokens this month
          </p>
          <span
            className="font-mono text-[10px] uppercase tracking-wider"
            style={{
              color:
                extractionPriceState === "current"
                  ? C.accent
                  : extractionPriceState === "stale"
                    ? C.amber
                    : C.alert,
            }}
          >
            {extractionPriceState === "current"
              ? "prices current"
              : extractionPriceState === "stale"
                ? "prices older than 90 days"
                : "models or prices unconfigured"}
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[10px] uppercase text-[#7C93A8]">input</p>
            <p className="mt-1 font-mono text-sm text-[#E6EFE8]">
              {budget.used.tokensIn.toLocaleString()} tokens
            </p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase text-[#7C93A8]">output</p>
            <p className="mt-1 font-mono text-sm text-[#E6EFE8]">
              {budget.used.tokensOut.toLocaleString()} tokens
            </p>
          </div>
        </div>
        {extraction && extractionBudgetState && (
          <div className="mt-3">
            <ProgressBar
              used={extractionBudgetState.tokensUsed}
              cap={extraction.limits.monthly_tokens}
              unit="tokens"
            />
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed text-[#8CA495]">
          {extraction
            ? `Token cap: ${extraction.limits.monthly_tokens.toLocaleString()} monthly · ${extraction.limits.per_run_tokens.toLocaleString()} per run. Quality gates: confidence ≥ ${Math.round(extraction.limits.confidence_floor * 100)}% · duplicate similarity ≥ ${Math.round(extraction.limits.duplicate_similarity * 100)}% · max ${extraction.limits.max_proposals_per_mechanism} proposals per mechanism. Prices verified: ${extraction.prices_verified_on ?? "not yet configured"}. Routing: cheap ${extraction.tiers.cheap.model_id ?? "unset"} · strong ${extraction.tiers.strong.model_id ?? "unset"}.`
            : "corpora/_ops/extraction.json is missing; extraction cannot quote or run."}
        </p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="monthly call cap"
          help="How many outbound API requests the whole fleet may make per month before runs are blocked."
        >
          <input
            type="number"
            min={0}
            step={1000}
            value={calls}
            disabled={!writeEnabled || pending}
            onChange={(e) => setCalls(Number(e.target.value))}
            className={numberInputClass(!writeEnabled)}
          />
        </Field>
        <Field
          label="monthly spend cap (usd)"
          help="Dollar ceiling for the month. Stays at $0 usage while every source is free; guards future paid jobs."
        >
          <input
            type="number"
            min={0}
            step={1}
            value={usd}
            disabled={!writeEnabled || pending}
            onChange={(e) => setUsd(Number(e.target.value))}
            className={numberInputClass(!writeEnabled)}
          />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!writeEnabled || pending || !dirty}
          className="rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "saving…" : "save caps"}
        </button>
        <span className="text-[11px] text-[#8CA495]">
          Saving commits corpora/_ops/budget.json to git with an “ops:” message.
        </span>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}

// ---------- Run flow (dry-run → quote → confirm) ----------

type RunPhase =
  | { kind: "idle" }
  | { kind: "dispatching" }
  | { kind: "polling"; dispatchId: string; attempt: number; runUrl?: string }
  | { kind: "quote"; quote: QuoteArtifact; runUrl?: string; raiseCap: boolean }
  | { kind: "timeout"; runUrl?: string }
  | { kind: "no_quote"; runUrl?: string }
  | { kind: "failed"; message: string; runUrl?: string }
  | { kind: "confirming" }
  | { kind: "dispatched" }
  | { kind: "error"; message: string };

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 12; // ~60s

function RunFlow({
  writeEnabled,
  connectorId,
  targets,
  optionById,
  optionOrder,
}: {
  writeEnabled: boolean;
  connectorId: string;
  targets: string[];
  optionById: Map<string, MechanismOption>;
  optionOrder: MechanismOption[];
}) {
  const targetGroups = groupIdsByNode(targets, optionById, optionOrder);
  const [target, setTarget] = useState<string>(targets[0] ?? "");
  const [phase, setPhase] = useState<RunPhase>({ kind: "idle" });

  // The displayed value IS the dispatched value: a controlled <select> paints
  // its first option when `value` matches no option, so a stale state target
  // (e.g. after the targets list was edited under it) would silently dispatch
  // a target the operator never sees. Reconcile at render instead (D-039).
  const selected = targets.includes(target) ? target : targets[0] ?? "";

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const poll = useCallback(
    async (dispatchId: string) => {
      let runUrl: string | undefined;
      for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
        setPhase({ kind: "polling", dispatchId, attempt, runUrl });
        await sleep(POLL_INTERVAL_MS);
        const res: PollResult = await pollDryRunAction(dispatchId);
        if (!res.ok) {
          setPhase({ kind: "error", message: res.error });
          return;
        }
        runUrl = res.runUrl ?? runUrl;
        if (res.state === "ready" && res.quote) {
          setPhase({ kind: "quote", quote: res.quote, runUrl, raiseCap: false });
          return;
        }
        if (res.state === "failed") {
          setPhase({
            kind: "failed",
            message: res.error ?? "the dry run did not succeed",
            runUrl,
          });
          return;
        }
        if (res.state === "no_quote") {
          setPhase({ kind: "no_quote", runUrl });
          return;
        }
      }
      setPhase({ kind: "timeout", runUrl });
    },
    [],
  );

  const startRun = useCallback(async () => {
    setPhase({ kind: "dispatching" });
    const res = await startDryRunAction(connectorId, selected || null);
    if (!res.ok) {
      setPhase({ kind: "error", message: res.error });
      return;
    }
    void poll(res.dispatchId);
  }, [connectorId, selected, poll]);

  // Changing the selector while a quote is on screen discards the quote — a
  // quote can only ever be confirmed against the target it priced (D-039).
  const onSelectTarget = useCallback((value: string) => {
    setTarget(value);
    setPhase((p) => (p.kind === "quote" ? { kind: "idle" } : p));
  }, []);

  const confirm = useCallback(
    async (quote: QuoteArtifact, raiseCap: boolean) => {
      setPhase({ kind: "confirming" });
      // The real run uses the target the QUOTE priced (echoed back in the
      // artifact), never a fresh dropdown read — the estimate is the single
      // source of truth for the dispatch (D-039).
      const res = await confirmRealRunAction({
        connectorId,
        target: quote.target ?? (selected || null),
        raiseCap,
        quote,
      });
      setPhase(res.ok ? { kind: "dispatched" } : { kind: "error", message: res.error });
    },
    [connectorId, selected],
  );

  const busy =
    phase.kind === "dispatching" ||
    phase.kind === "polling" ||
    phase.kind === "confirming";

  return (
    <div className="mt-4 rounded-md border border-[#243329] bg-[#1A2620] p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">run now</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        {targets.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[#8CA495]">which target</span>
            <select
              value={selected}
              disabled={!writeEnabled || busy}
              onChange={(e) => onSelectTarget(e.target.value)}
              className="rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-sm text-[#E6EFE8] outline-none focus:border-[#34D399] disabled:opacity-50"
            >
              {targetGroups.map((group) => (
                <optgroup key={group.parent} label={nodeHeading(group)}>
                  {group.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={startRun}
          disabled={!writeEnabled || busy}
          className="rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "working…" : "run"}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-[#8CA495]">
        Run first shows a cost estimate (a safe dry run — no data is harvested). You confirm before
        anything real happens.
      </p>

      {phase.kind === "dispatching" && (
        <Notice tone="warn">Starting the estimate…</Notice>
      )}
      {phase.kind === "polling" && (
        <Notice tone="warn">
          Waiting for the estimate… (check {phase.attempt}/{MAX_POLLS})
          {phase.runUrl && (
            <>
              {" · "}
              <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
                view the run
              </a>
            </>
          )}
        </Notice>
      )}
      {phase.kind === "failed" && (
        <Notice tone="err">
          The estimate run failed: {phase.message}.{" "}
          {phase.runUrl && (
            <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
              open the run
            </a>
          )}
        </Notice>
      )}
      {phase.kind === "no_quote" && (
        <Notice tone="err">
          The dry run succeeded but no estimate file was produced.{" "}
          {phase.runUrl && (
            <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
              open the run
            </a>
          )}
        </Notice>
      )}
      {phase.kind === "timeout" && (
        <Notice tone="warn">
          Quote pending — this is taking longer than a minute.{" "}
          {phase.runUrl ? (
            <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
              check the run
            </a>
          ) : (
            "check the Actions tab."
          )}
        </Notice>
      )}
      {phase.kind === "dispatched" && (
        <Notice tone="ok">Run started. Follow it on the connectors page or the Actions tab.</Notice>
      )}
      {phase.kind === "error" && <Notice tone="err">{phase.message}</Notice>}

      {phase.kind === "quote" && (
        <QuoteConfirm
          quote={phase.quote}
          raiseCap={phase.raiseCap}
          onToggleRaise={(v) => setPhase({ ...phase, raiseCap: v })}
          onConfirm={() => confirm(phase.quote, phase.raiseCap)}
          onCancel={() => setPhase({ kind: "idle" })}
          runUrl={phase.runUrl}
        />
      )}
    </div>
  );
}

function QuoteConfirm({
  quote,
  raiseCap,
  onToggleRaise,
  onConfirm,
  onCancel,
  runUrl,
}: {
  quote: QuoteArtifact;
  raiseCap: boolean;
  onToggleRaise: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  runUrl?: string;
}) {
  // Per-run limits are hard: if the gate blocked for a reason other than
  // budget, raise-cap cannot rescue it, so confirm stays disabled.
  const blockedByLimits = !quote.allowed && !quote.over_budget;
  const needsRaise = quote.over_budget;
  const canConfirm = !blockedByLimits && (!needsRaise || raiseCap);

  return (
    <div className="mt-3 rounded-md border border-[#243329] bg-[#0E1512] p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
        estimate{quote.target ? ` — ${quote.target}` : ""}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
        {[
          { label: "api calls", value: String(quote.quote.calls) },
          { label: "records", value: String(quote.quote.records) },
          { label: "duration", value: `${quote.quote.duration_s}s` },
          { label: "est. cost", value: formatUsd(quote.quote.estimated_usd) },
        ].map((row) => (
          <div key={row.label}>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
              {row.label}
            </dt>
            <dd className="mt-0.5 font-mono text-sm text-[#E6EFE8]">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-[#8CA495]">
        Against this month: {quote.budget.used.calls}/{quote.budget.caps.calls} calls used,{" "}
        {formatUsd(quote.budget.used.usd)}/{formatUsd(quote.budget.caps.usd)} spent.
      </p>

      {blockedByLimits && (
        <Notice tone="err">
          This run exceeds a per-run safety limit and cannot be raised away: {quote.reasons.join("; ")}.
          Lower the estimate or raise the connector’s limit first.
        </Notice>
      )}

      {needsRaise && !blockedByLimits && (
        <label className="mt-3 flex items-start gap-2 rounded-md border border-[#E4B54E55] bg-[#E4B54E10] p-3">
          <input
            type="checkbox"
            checked={raiseCap}
            onChange={(e) => onToggleRaise(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs leading-relaxed text-[#E4B54E]">
            This run would go over the monthly budget. Tick to raise the cap for this one run — the
            decision is logged to the decision log automatically.
          </span>
        </label>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm}
          className="rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915] disabled:cursor-not-allowed disabled:opacity-40"
        >
          confirm & run
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[#243329] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#8CA495] transition hover:border-[#7C93A8]"
        >
          cancel
        </button>
        {runUrl && (
          <a className="font-mono text-[11px] text-[#7C93A8] underline" href={runUrl} target="_blank" rel="noreferrer">
            view dry run
          </a>
        )}
      </div>
    </div>
  );
}

// ---------- Extraction dispatch (quote → confirm → run, D-085) ----------

const EXTRACTION_MODE_OPTIONS: { id: string; label: string; help: string }[] = [
  { id: "effects", label: "effects", help: "distinct named phenomena (L2)" },
  {
    id: "realizations",
    label: "realizations",
    help:
      "interface embodiments (L3) — scoped to a mechanism it reads observed artifacts; scoped to an effect it transfers that effect into product-UI patterns marked derivation=inferred",
  },
  { id: "interactions", label: "interactions", help: "mechanism pairs treated together" },
  { id: "dissent", label: "dissent", help: "critiques and failed replications" },
  { id: "mechanism", label: "mechanism record", help: "draft a full L1 record for a seed candidate" },
  { id: "dossier", label: "dossier draft", help: "draft a full scored dossier for owner review" },
];

type ExtractionPhase =
  | { kind: "idle" }
  | { kind: "dispatching" }
  | { kind: "polling"; dispatchId: string; attempt: number; runUrl?: string }
  | { kind: "quote"; quote: ExtractionQuote; runUrl?: string }
  | { kind: "timeout"; runUrl?: string }
  | { kind: "no_quote"; runUrl?: string }
  | { kind: "failed"; message: string; runUrl?: string }
  | { kind: "confirming" }
  | { kind: "dispatched" }
  | { kind: "error"; message: string };

const EXTRACT_MAX_POLLS = 36; // ~3min — quote runs npm ci first

function ExtractionDispatchPanel({
  writeEnabled,
  mechanismOptions,
  optionById,
  packOptions,
  segmentOptions,
  effectOptions,
}: {
  writeEnabled: boolean;
  mechanismOptions: MechanismOption[];
  optionById: Map<string, MechanismOption>;
  packOptions: string[];
  segmentOptions: string[];
  effectOptions: string[];
}) {
  const [mode, setMode] = useState("effects");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("mechanism");
  const [scopeId, setScopeId] = useState(mechanismOptions[0]?.id ?? "");
  const [phase, setPhase] = useState<ExtractionPhase>({ kind: "idle" });

  const mechanismGroups = groupIdsByNode(
    mechanismOptions.map((option) => option.id),
    optionById,
    mechanismOptions,
  );
  const scopeIds =
    scopeKind === "mechanism"
      ? mechanismOptions.map((option) => option.id)
      : scopeKind === "pack"
        ? packOptions
        : scopeKind === "segment"
          ? segmentOptions
          : effectOptions;
  const selectedScopeId = scopeIds.includes(scopeId) ? scopeId : scopeIds[0] ?? "";

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const poll = useCallback(async (dispatchId: string) => {
    let runUrl: string | undefined;
    for (let attempt = 1; attempt <= EXTRACT_MAX_POLLS; attempt++) {
      setPhase({ kind: "polling", dispatchId, attempt, runUrl });
      await sleep(POLL_INTERVAL_MS);
      const res: ExtractionPollResult = await pollExtractionQuoteAction(dispatchId);
      if (!res.ok) {
        setPhase({ kind: "error", message: res.error });
        return;
      }
      runUrl = res.runUrl ?? runUrl;
      if (res.state === "ready" && res.quote) {
        setPhase({ kind: "quote", quote: res.quote, runUrl });
        return;
      }
      if (res.state === "failed") {
        setPhase({
          kind: "failed",
          message: res.error ?? "the dry run did not succeed",
          runUrl,
        });
        return;
      }
      if (res.state === "no_quote") {
        setPhase({ kind: "no_quote", runUrl });
        return;
      }
    }
    setPhase({ kind: "timeout", runUrl });
  }, []);

  const startQuote = useCallback(async () => {
    setPhase({ kind: "dispatching" });
    const res = await startExtractionQuoteAction({
      mode,
      scopeKind,
      scopeId: selectedScopeId,
    });
    if (!res.ok) {
      setPhase({ kind: "error", message: res.error });
      return;
    }
    void poll(res.dispatchId);
  }, [mode, scopeKind, selectedScopeId, poll]);

  const confirm = useCallback(
    async (quote: ExtractionQuote) => {
      setPhase({ kind: "confirming" });
      // The real dispatch uses the scope the QUOTE priced, echoed back in the
      // artifact — never a fresh dropdown read (D-039).
      const res = await confirmExtractionRunAction({
        mode: quote.mode,
        scopeKind: quote.scope.kind,
        scopeId: quote.scope.id,
      });
      setPhase(res.ok ? { kind: "dispatched" } : { kind: "error", message: res.error });
    },
    [],
  );

  // Changing any picker while a quote is on screen discards the quote — a
  // quote is only ever confirmable against exactly what it priced (D-039).
  const discardQuote = () =>
    setPhase((p) => (p.kind === "quote" ? { kind: "idle" } : p));

  const busy =
    phase.kind === "dispatching" ||
    phase.kind === "polling" ||
    phase.kind === "confirming";

  const modeHelp = EXTRACTION_MODE_OPTIONS.find((option) => option.id === mode)?.help;

  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <header>
        <h2 className="font-display text-lg font-medium text-[#E6EFE8]">
          Run extraction
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-[#8CA495]">
          Reads harvested corpora and asks the configured OpenRouter models for ONE
          grounded task type; every item lands in the proposal queue for review —
          never directly in the knowledge layer. You always see a token/cost
          estimate and confirm before any paid call happens.
        </p>
      </header>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[#8CA495]">what to extract</span>
          <select
            value={mode}
            disabled={!writeEnabled || busy}
            onChange={(e) => {
              setMode(e.target.value);
              // An effect scope only applies to mode=realizations (D-112), so
              // leaving that mode drops back to the mechanism scope.
              if (e.target.value !== "realizations" && scopeKind === "effect") {
                setScopeKind("mechanism");
              }
              discardQuote();
            }}
            className="rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-sm text-[#E6EFE8] outline-none focus:border-[#34D399] disabled:opacity-50"
          >
            {EXTRACTION_MODE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[#8CA495]">scope</span>
          <select
            value={scopeKind}
            disabled={!writeEnabled || busy}
            onChange={(e) => {
              setScopeKind(e.target.value as ScopeKind);
              discardQuote();
            }}
            className="rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-sm text-[#E6EFE8] outline-none focus:border-[#34D399] disabled:opacity-50"
          >
            <option value="mechanism">one mechanism</option>
            <option value="pack">a pack</option>
            <option value="segment">a segment</option>
            {mode === "realizations" && effectOptions.length > 0 && (
              <option value="effect">an effect (transfer)</option>
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[#8CA495]">which {scopeKind}</span>
          <select
            value={selectedScopeId}
            disabled={!writeEnabled || busy}
            onChange={(e) => {
              setScopeId(e.target.value);
              discardQuote();
            }}
            className="rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-sm text-[#E6EFE8] outline-none focus:border-[#34D399] disabled:opacity-50"
          >
            {scopeKind === "mechanism"
              ? mechanismGroups.map((group) => (
                  <optgroup key={group.parent} label={nodeHeading(group)}>
                    {group.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.id}
                      </option>
                    ))}
                  </optgroup>
                ))
              : scopeIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
          </select>
        </label>
        <button
          type="button"
          onClick={startQuote}
          disabled={!writeEnabled || busy || !selectedScopeId}
          className="rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "working…" : "estimate"}
        </button>
      </div>
      {modeHelp && (
        <p className="mt-2 text-[11px] leading-snug text-[#8CA495]">{modeHelp}</p>
      )}

      {phase.kind === "dispatching" && <Notice tone="warn">Starting the estimate…</Notice>}
      {phase.kind === "polling" && (
        <Notice tone="warn">
          Waiting for the estimate… (check {phase.attempt}/{EXTRACT_MAX_POLLS})
          {phase.runUrl && (
            <>
              {" · "}
              <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
                view the run
              </a>
            </>
          )}
        </Notice>
      )}
      {phase.kind === "failed" && (
        <Notice tone="err">
          The estimate run failed: {phase.message}.{" "}
          {phase.runUrl && (
            <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
              open the run
            </a>
          )}
        </Notice>
      )}
      {phase.kind === "no_quote" && (
        <Notice tone="err">
          The dry run succeeded but no estimate file was produced.{" "}
          {phase.runUrl && (
            <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
              open the run
            </a>
          )}
        </Notice>
      )}
      {phase.kind === "timeout" && (
        <Notice tone="warn">
          Quote pending — this is taking longer than expected.{" "}
          {phase.runUrl ? (
            <a className="underline" href={phase.runUrl} target="_blank" rel="noreferrer">
              check the run
            </a>
          ) : (
            "check the Actions tab."
          )}
        </Notice>
      )}
      {phase.kind === "dispatched" && (
        <Notice tone="ok">
          Extraction started. Proposals land in /review when the run commits; gate
          outcomes appear in the panel above after the manifest updates.
        </Notice>
      )}
      {phase.kind === "error" && <Notice tone="err">{phase.message}</Notice>}

      {phase.kind === "quote" && (
        <div className="mt-3 rounded-md border border-[#243329] bg-[#0E1512] p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            estimate — {phase.quote.mode} · {phase.quote.scope.kind}={phase.quote.scope.id}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
            {[
              {
                label: "llm calls",
                value: `${phase.quote.calls.total} (${phase.quote.calls.cheap} cheap + ${phase.quote.calls.strong} strong)`,
              },
              {
                label: "tokens (upper bound)",
                value: phase.quote.tokens.total_upper_bound.toLocaleString(),
              },
              {
                label: "records this slice",
                value: `${phase.quote.records.selected.toLocaleString()} selected · ${phase.quote.records.skipped_irrelevant.toLocaleString()} skipped`,
              },
              {
                label: "records remaining",
                value: phase.quote.records.remaining.toLocaleString(),
              },
              { label: "est. cost", value: `$${phase.quote.estimated_usd.toFixed(4)}` },
              {
                label: "prices",
                value:
                  phase.quote.price_state === "current"
                    ? `verified ${phase.quote.prices_verified_on}`
                    : phase.quote.price_state,
              },
            ].map((row) => (
              <div key={row.label}>
                <dt className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
                  {row.label}
                </dt>
                <dd className="mt-0.5 font-mono text-sm text-[#E6EFE8]">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-[#8CA495]">
            Mechanisms in scope: {phase.quote.scope.mechanism_ids.join(", ") || "none"} ·
            caps: {phase.quote.caps.per_run_tokens.toLocaleString()} tokens/run,{" "}
            {phase.quote.caps.monthly_tokens.toLocaleString()}/month.
          </p>
          {!phase.quote.allowed && (
            <Notice tone="err">
              This run is blocked and the workflow will refuse it:{" "}
              {phase.quote.reasons.join("; ")}.
            </Notice>
          )}
          {phase.quote.allowed && phase.quote.capped && (
            <Notice tone="warn">
              This ranked slice respects the per-run cap. The run will commit partial
              coverage and resume with the remaining {phase.quote.records.remaining.toLocaleString()}{" "}
              relevant records next time.
            </Notice>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => confirm(phase.quote)}
              disabled={!phase.quote.allowed}
              className="rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915] disabled:cursor-not-allowed disabled:opacity-40"
            >
              confirm & run
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: "idle" })}
              className="rounded-md border border-[#243329] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#8CA495] transition hover:border-[#7C93A8]"
            >
              cancel
            </button>
            {phase.runUrl && (
              <a
                className="font-mono text-[11px] text-[#7C93A8] underline"
                href={phase.runUrl}
                target="_blank"
                rel="noreferrer"
              >
                view dry run
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Connector card ----------

function ConnectorCard({
  writeEnabled,
  view,
  mechanismOptions,
  optionById,
}: {
  writeEnabled: boolean;
  view: ConnectorView;
  mechanismOptions: MechanismOption[];
  optionById: Map<string, MechanismOption>;
}) {
  const [config, setConfig] = useState<OpsConnectorConfig>(view.config);
  const [newTarget, setNewTarget] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();

  // The current targets and the still-addable options, both grouped under their
  // L0 node so the operator sees what they are targeting by node (D-071).
  const targetGroups = groupIdsByNode(config.targets, optionById, mechanismOptions);
  const addableGroups = groupIdsByNode(
    mechanismOptions
      .filter((option) => !config.targets.includes(option.id))
      .map((option) => option.id),
    optionById,
    mechanismOptions,
  );

  const patch = (p: Partial<OpsConnectorConfig>) => setConfig((c) => ({ ...c, ...p }));

  const save = useCallback(() => {
    setMsg(null);
    start(async () => {
      const res = await saveConnectorConfigAction(config);
      setMsg(res.ok ? { tone: "ok", text: "Saved. Applies to the next run." } : { tone: "err", text: res.error });
    });
  }, [config]);

  const addTarget = () => {
    const t = newTarget.trim();
    if (t && !config.targets.includes(t)) patch({ targets: [...config.targets, t] });
    setNewTarget("");
  };
  const removeTarget = (t: string) =>
    patch({ targets: config.targets.filter((x) => x !== t) });

  const lastRun = view.lastRun;

  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2.5">
          <h3 className="font-display text-lg font-medium text-[#E6EFE8]">{config.connector_id}</h3>
          <span className="font-mono text-[11px] text-[#7C93A8]">{describeCadence(config.cadence.every_days)}</span>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider"
          style={{
            color: config.paused ? C.amber : C.accent,
            borderColor: `${config.paused ? C.amber : C.accent}40`,
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: config.paused ? C.amber : C.accent }}
          />
          {config.paused ? "paused" : "active"}
        </span>
      </header>

      {/* Last run summary */}
      <div className="mt-3 rounded-md border border-[#243329] bg-[#1A2620] px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">last run</p>
        {lastRun ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
            <span style={{ color: RUN_COLOR[lastRun.status] }}>{lastRun.status}</span>
            <span className="text-[#E6EFE8]">{formatTimestamp(lastRun.timestamp)}</span>
            <span className="text-[#8CA495]">{lastRun.apiCalls ?? "—"} calls</span>
            <span className="text-[#8CA495]">
              {lastRun.estimatedUsd === null ? "—" : formatUsd(lastRun.estimatedUsd)}
            </span>
            {lastRun.capped && <span style={{ color: C.amber }}>stopped at call limit</span>}
          </div>
        ) : (
          <p className="mt-1 text-xs text-[#8CA495]">Never run yet.</p>
        )}
        {lastRun?.error && (
          <p className="mt-1 text-[11px] leading-snug text-[#E4B54E]">{lastRun.error}</p>
        )}
      </div>

      {/* Pause toggle */}
      <div className="mt-4 flex items-start gap-3 rounded-md border border-[#243329] p-3">
        <input
          type="checkbox"
          checked={config.paused}
          disabled={!writeEnabled || pending}
          onChange={(e) =>
            patch({
              paused: e.target.checked,
              paused_reason: e.target.checked ? config.paused_reason ?? "" : null,
            })
          }
          className="mt-0.5"
        />
        <div className="flex-1">
          <p className="text-sm text-[#E6EFE8]">Pause this connector</p>
          <p className="text-[11px] text-[#8CA495]">
            Paused connectors are skipped by the weekly schedule, with the reason written to the run
            summary. You can still run them by hand.
          </p>
          {config.paused && (
            <input
              type="text"
              value={config.paused_reason ?? ""}
              disabled={!writeEnabled || pending}
              placeholder="Why is it paused? (required)"
              onChange={(e) => patch({ paused_reason: e.target.value })}
              className="mt-2 w-full rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 text-sm text-[#E6EFE8] outline-none focus:border-[#34D399] disabled:opacity-50"
            />
          )}
        </div>
      </div>

      {/* Limits + cadence */}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field
          label="max calls / run"
          help="Hard ceiling on API requests for one run. When reached, the run stops safely and is marked partial — it never runs away."
        >
          <input
            type="number"
            min={1}
            value={config.limits.max_calls_per_run}
            disabled={!writeEnabled || pending}
            onChange={(e) =>
              patch({ limits: { ...config.limits, max_calls_per_run: Number(e.target.value) } })
            }
            className={numberInputClass(!writeEnabled)}
          />
        </Field>
        <Field
          label="max records / run"
          help="Upper bound on records one run may collect."
        >
          <input
            type="number"
            min={1}
            value={config.limits.max_records_per_run}
            disabled={!writeEnabled || pending}
            onChange={(e) =>
              patch({ limits: { ...config.limits, max_records_per_run: Number(e.target.value) } })
            }
            className={numberInputClass(!writeEnabled)}
          />
        </Field>
        <Field
          label="run every (days)"
          help={`How often the schedule may run it — ${describeCadence(config.cadence.every_days)}.`}
        >
          <input
            type="number"
            min={1}
            value={config.cadence.every_days}
            disabled={!writeEnabled || pending}
            onChange={(e) => patch({ cadence: { every_days: Number(e.target.value) } })}
            className={numberInputClass(!writeEnabled)}
          />
        </Field>
      </div>

      {config.connector_id === "evidence" && config.saturation && (
        <div className="mt-4 rounded-md border border-[#243329] p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            saturation policy
          </p>
          <p className="mt-1 text-[11px] text-[#8CA495]">
            The harvest stops when the rolling novelty window flattens or a configured cap is reached.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-4">
            {(
              [
                ["window_queries", "window queries", 1],
                ["novelty_threshold", "novelty threshold", 0.001],
                ["minimum_queries", "minimum queries", 1],
                ["records_per_query", "records / query", 1],
                ["checkpoint_every_queries", "checkpoint every", 1],
                ["soft_time_limit_minutes", "soft minutes", 1],
              ] as const
            ).map(([key, label, step]) => (
              <Field key={key} label={label} help={`Evidence saturation setting: ${key}.`}>
                <input
                  type="number"
                  min={step}
                  max={key === "novelty_threshold" ? 1 : undefined}
                  step={step}
                  value={config.saturation?.[key] ?? ""}
                  disabled={!writeEnabled || pending}
                  onChange={(e) =>
                    patch({
                      saturation: {
                        ...config.saturation!,
                        [key]: Number(e.target.value),
                      },
                    })
                  }
                  className={numberInputClass(!writeEnabled)}
                />
              </Field>
            ))}
            {(["relevance", "recency", "citation"] as const).map((key) => (
              <Field key={key} label={`${key} share`} help="Relative share of search queries.">
                <input
                  type="number"
                  min={1}
                  value={config.saturation?.retrieval_shares[key] ?? ""}
                  disabled={!writeEnabled || pending}
                  onChange={(e) =>
                    patch({
                      saturation: {
                        ...config.saturation!,
                        retrieval_shares: {
                          ...config.saturation!.retrieval_shares,
                          [key]: Number(e.target.value),
                        },
                      },
                    })
                  }
                  className={numberInputClass(!writeEnabled)}
                />
              </Field>
            ))}
            <Field label="graph anchors" help="Maximum metadata-confirmed records expanded per run.">
              <input
                type="number"
                min={1}
                value={config.saturation.citation_graph.max_anchors}
                disabled={!writeEnabled || pending}
                onChange={(e) =>
                  patch({
                    saturation: {
                      ...config.saturation!,
                      citation_graph: {
                        ...config.saturation!.citation_graph,
                        max_anchors: Number(e.target.value),
                      },
                    },
                  })
                }
                className={numberInputClass(!writeEnabled)}
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-5 text-xs text-[#E6EFE8]">
            {(
              [
                ["backward_references", "Expand references"],
                ["forward_citations", "Expand forward citations"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.saturation?.citation_graph[key] ?? false}
                  disabled={!writeEnabled || pending}
                  onChange={(e) =>
                    patch({
                      saturation: {
                        ...config.saturation!,
                        citation_graph: {
                          ...config.saturation!.citation_graph,
                          [key]: e.target.checked,
                        },
                      },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Targets */}
      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
          what it harvests
        </p>
        <p className="mt-1 text-[11px] text-[#8CA495]">
          The exact things the schedule collects — the machine harvests what you point it at, not
          whatever files happen to exist. A target only runs on the schedule if its record changed
          in the last week.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {config.targets.length === 0 && (
            <span className="text-xs text-[#8CA495]">No targets — nothing runs on the schedule.</span>
          )}
          {targetGroups.map((group) => (
            <div key={group.parent}>
              <p
                className="font-mono text-[10px] uppercase tracking-widest"
                style={{ color: group.crossCutting ? C.amber : C.slate }}
              >
                {nodeHeading(group)}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {group.options.map((option) => (
                  <span
                    key={option.id}
                    title={option.name}
                    className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] text-[#E6EFE8]"
                    style={{
                      borderColor: option.crossCutting ? `${C.amber}55` : C.border,
                      backgroundColor: C.inner,
                    }}
                  >
                    {option.id}
                    {writeEnabled && (
                      <button
                        type="button"
                        onClick={() => removeTarget(option.id)}
                        className="text-[#7C93A8] hover:text-[#F87171]"
                        aria-label={`remove ${option.id}`}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        {writeEnabled && (
          <div className="mt-3 flex items-center gap-2">
            <select
              value={newTarget}
              disabled={pending}
              onChange={(e) => setNewTarget(e.target.value)}
              className="w-64 rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-xs text-[#E6EFE8] outline-none focus:border-[#34D399] disabled:opacity-50"
            >
              <option value="">add a target by node…</option>
              {addableGroups.map((group) => (
                <optgroup key={group.parent} label={nodeHeading(group)}>
                  {group.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.id} — {option.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              onClick={addTarget}
              disabled={!newTarget}
              className="rounded-md border border-[#243329] px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider text-[#8CA495] transition hover:border-[#34D399] hover:text-[#34D399] disabled:cursor-not-allowed disabled:opacity-40"
            >
              add
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!writeEnabled || pending}
          className="rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "saving…" : "save settings"}
        </button>
        <span className="text-[11px] text-[#8CA495]">
          Commits corpora/_ops/connectors/{config.connector_id}.json to git.
        </span>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <RunFlow
        writeEnabled={writeEnabled}
        connectorId={config.connector_id}
        targets={config.targets}
        optionById={optionById}
        optionOrder={mechanismOptions}
      />
    </section>
  );
}

// ---------- Root ----------

type HydrateStatus = "loading" | "ready" | "error";

export default function OpsClient({
  writeEnabled,
  budget,
  extraction,
  extractionBudgetState,
  extractionRun,
  extractionPriceState,
  connectors,
  mechanismOptions,
  packOptions,
  segmentOptions,
  effectOptions,
}: OpsClientProps) {
  const optionById = new Map(mechanismOptions.map((o) => [o.id, o]));
  // The page renders from the deploy-time filesystem snapshot; config saved
  // since the last deploy is invisible there, so showing that snapshot would
  // display stale settings that "change" once the live read lands — the
  // "different settings when I come back" report (D-040/D-041). When the write
  // surface is live, config comes ONLY from GitHub (the source the write path
  // commits to): we hold back the connector cards behind a short loading state
  // until the live read resolves, so the snapshot is never shown as if saved.
  const [views, setViews] = useState<ConnectorView[]>(connectors);
  const [configVersion, setConfigVersion] = useState(0);
  const [status, setStatus] = useState<HydrateStatus>(writeEnabled ? "loading" : "ready");
  const [errorText, setErrorText] = useState<string | null>(null);
  // Bumped by Retry to re-run the live read.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!writeEnabled) return;
    let cancelled = false;
    setStatus("loading");
    setErrorText(null);
    void (async () => {
      const res = await loadLiveConnectorConfigsAction();
      if (cancelled) return;
      if (!res.ok) {
        setStatus("error");
        setErrorText(res.error);
        return;
      }
      setViews((prev) =>
        prev.map((view) => {
          const live = res.configs[view.config.connector_id];
          return live ? { ...view, config: live } : view;
        }),
      );
      setConfigVersion((v) => v + 1);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [writeEnabled, reloadKey]);

  return (
    <div className="mt-6 flex flex-col gap-5">
      {!writeEnabled && (
        <div className="rounded-lg border border-dashed border-[#E4B54E55] bg-[#E4B54E10] px-4 py-4">
          <p className="text-sm leading-relaxed text-[#E4B54E]">
            Read-only. The operations write surface is disabled because the GitHub token
            (GH_OPS_TOKEN) and repo (GH_OPS_REPO) are not configured for this deployment. You can
            see the current settings and usage, but Save and Run are turned off.
          </p>
        </div>
      )}

      <BudgetPanel
        writeEnabled={writeEnabled}
        budget={budget}
        extraction={extraction}
        extractionBudgetState={extractionBudgetState}
        extractionPriceState={extractionPriceState}
      />
      <ExtractionRunPanel run={extractionRun} />
      <ExtractionDispatchPanel
        writeEnabled={writeEnabled}
        mechanismOptions={mechanismOptions}
        optionById={optionById}
        packOptions={packOptions}
        segmentOptions={segmentOptions}
        effectOptions={effectOptions}
      />

      {status === "loading" && (
        <div className="rounded-lg border border-[#243329] bg-[#151F1A] px-5 py-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            loading current settings…
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[#8CA495]">
            Reading each connector&apos;s committed config from git so the settings you see are the
            saved ones, not this deployment&apos;s snapshot.
          </p>
        </div>
      )}

      {status === "error" && (
        <div className="rounded-lg border border-[#F8717155] bg-[#F8717110] px-5 py-5">
          <p className="text-sm leading-relaxed text-[#F87171]">
            Could not load the current settings from git, so they are not shown to avoid
            displaying a stale copy. {errorText}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-3 rounded-md border border-[#34D399] px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-[#34D399] transition hover:bg-[#34D39915]"
          >
            retry
          </button>
        </div>
      )}

      {status === "ready" &&
        views.map((view) => (
          <ConnectorCard
            key={`${view.config.connector_id}-${configVersion}`}
            writeEnabled={writeEnabled}
            view={view}
            mechanismOptions={mechanismOptions}
            optionById={optionById}
          />
        ))}
    </div>
  );
}
