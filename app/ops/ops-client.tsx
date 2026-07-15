"use client";

/**
 * app/ops/ops-client.tsx — the interactive Operations console (D-023/D-025).
 *
 * Plain-language controls for a non-technical operator: no raw JSON anywhere.
 * Every mutation calls a server action in ./actions (the only path to
 * api.github.com). Type-only imports from lib/ops keep node:fs out of the
 * client bundle.
 */

import { useCallback, useState, useTransition } from "react";
import type { BudgetSnapshot, OpsConnectorConfig, QuoteArtifact } from "@/lib/ops";
import {
  confirmRealRunAction,
  pollDryRunAction,
  saveBudgetAction,
  saveConnectorConfigAction,
  startDryRunAction,
  type PollResult,
} from "./actions";

// ---------- Shared props ----------

export interface LastRunView {
  status: "success" | "partial" | "failed";
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

export interface OpsClientProps {
  writeEnabled: boolean;
  budget: BudgetSnapshot;
  connectors: ConnectorView[];
  availableMechanismIds: string[];
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
}: {
  writeEnabled: boolean;
  budget: BudgetSnapshot;
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
          Usage is counted from real run costs — it is not a guess. Every source is a free public
          API today, so the dollar figure guards future paid work and the call count is the
          meaningful limit.
        </p>
      </header>

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
}: {
  writeEnabled: boolean;
  connectorId: string;
  targets: string[];
}) {
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
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
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

// ---------- Connector card ----------

function ConnectorCard({
  writeEnabled,
  view,
  availableMechanismIds,
}: {
  writeEnabled: boolean;
  view: ConnectorView;
  availableMechanismIds: string[];
}) {
  const [config, setConfig] = useState<OpsConnectorConfig>(view.config);
  const [newTarget, setNewTarget] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();

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
        <div className="mt-2 flex flex-wrap gap-1.5">
          {config.targets.length === 0 && (
            <span className="text-xs text-[#8CA495]">No targets — nothing runs on the schedule.</span>
          )}
          {config.targets.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1.5 rounded border border-[#243329] bg-[#1A2620] px-2 py-0.5 font-mono text-[11px] text-[#E6EFE8]"
            >
              {t}
              {writeEnabled && (
                <button
                  type="button"
                  onClick={() => removeTarget(t)}
                  className="text-[#7C93A8] hover:text-[#F87171]"
                  aria-label={`remove ${t}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {writeEnabled && (
          <div className="mt-2 flex items-center gap-2">
            <input
              list={`mech-${config.connector_id}`}
              value={newTarget}
              disabled={pending}
              placeholder="add a mechanism id (e.g. LA-01)"
              onChange={(e) => setNewTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTarget();
                }
              }}
              className="w-56 rounded-md border border-[#243329] bg-[#0E1512] px-2.5 py-1.5 font-mono text-xs text-[#E6EFE8] outline-none focus:border-[#34D399]"
            />
            <datalist id={`mech-${config.connector_id}`}>
              {availableMechanismIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <button
              type="button"
              onClick={addTarget}
              className="rounded-md border border-[#243329] px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider text-[#8CA495] transition hover:border-[#34D399] hover:text-[#34D399]"
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

      <RunFlow writeEnabled={writeEnabled} connectorId={config.connector_id} targets={config.targets} />
    </section>
  );
}

// ---------- Root ----------

export default function OpsClient({
  writeEnabled,
  budget,
  connectors,
  availableMechanismIds,
}: OpsClientProps) {
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

      <BudgetPanel writeEnabled={writeEnabled} budget={budget} />

      {connectors.map((view) => (
        <ConnectorCard
          key={view.config.connector_id}
          writeEnabled={writeEnabled}
          view={view}
          availableMechanismIds={availableMechanismIds}
        />
      ))}
    </div>
  );
}
