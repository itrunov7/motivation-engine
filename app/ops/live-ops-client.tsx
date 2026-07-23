"use client";

/**
 * app/ops/live-ops-client.tsx — the live operations view (D-086).
 *
 * Shows what the fleet is doing right now: in-flight jobs with phase, elapsed
 * time, progress against caps, and current spend; recent runs with outcomes
 * and their saturation report; the next scheduled runs; and the four queues.
 * The initial snapshot is computed server-side from committed files; this
 * client polls getLiveOpsSnapshotAction to fill in live Actions runs and to
 * refresh — every 15s while a job is running, every 60s when idle. No status
 * is hardcoded: every value is computed from run artifacts, the progress
 * heartbeat, or the manifests, with a designed empty state otherwise.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  LiveOpsSnapshot,
  LiveRecentRun,
  LiveRun,
  LiveScheduledRun,
} from "@/lib/types";
import { getLiveOpsSnapshotAction } from "./actions";

const STATUS_COLOR: Record<string, string> = {
  success: "#34D399",
  partial: "#E4B54E",
  failed: "#F87171",
  running: "#34D399",
};

const KIND_LABEL: Record<LiveRun["kind"], string> = {
  harvest: "harvest",
  extraction: "extraction",
  analysis: "analysis",
  health: "health",
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatWhen(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "unknown";
  const deltaMs = time - now;
  const abs = Math.abs(deltaMs);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  const unit =
    abs >= day
      ? `${Math.round(abs / day)}d`
      : abs >= hour
        ? `${Math.round(abs / hour)}h`
        : abs >= minute
          ? `${Math.round(abs / minute)}m`
          : "<1m";
  return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

function money(usd: number | null): string {
  if (usd === null) return "—";
  return usd === 0 ? "$0" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          {title}
        </h3>
        {hint ? (
          <span className="font-mono text-[10px] text-[#7C93A8]">{hint}</span>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-[#243329] bg-[#0E1512] p-4 text-sm text-[#8CA495]">
      {children}
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number | null }) {
  const pct =
    total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0E1512]">
        <div
          className="h-full rounded-full bg-[#34D399] transition-all"
          style={{ width: pct === null ? "12%" : `${pct}%` }}
        />
      </div>
      <span className="mt-1 block font-mono text-[10px] text-[#7C93A8]">
        {total !== null ? `${done} / ${total}` : `${done}`}
        {pct !== null ? ` · ${pct}%` : ""}
      </span>
    </div>
  );
}

function RunningCard({ run, now }: { run: LiveRun; now: number }) {
  const progress = run.progress;
  return (
    <li className="rounded-md border border-[#243329] bg-[#0E1512] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="rounded-full bg-[#34D399]/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#34D399]">
            {KIND_LABEL[run.kind]}
          </span>
          <span className="font-mono text-[12px] text-[#E6EFE8]">
            {progress?.target ?? run.workflow}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
            {run.status.replaceAll("_", " ")}
          </span>
        </div>
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10px] text-[#7C93A8] underline hover:text-[#34D399]"
        >
          Actions run →
        </a>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-[#8CA495]">
        <span>
          phase: <span className="text-[#E6EFE8]">{progress?.phase ?? run.phase ?? "starting"}</span>
        </span>
        <span>
          elapsed: <span className="text-[#E6EFE8]">{formatElapsed(run.elapsedS)}</span>
        </span>
      </div>

      {progress ? (
        <div className="mt-3 space-y-2">
          <ProgressBar done={progress.progress.done} total={progress.progress.total} />
          <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-[#8CA495]">
            {progress.records !== null ? (
              <span>
                records: <span className="text-[#E6EFE8]">{progress.records}</span>
              </span>
            ) : null}
            {progress.spend.api_calls !== null && progress.caps.per_run_calls !== null ? (
              <span>
                calls:{" "}
                <span className="text-[#E6EFE8]">
                  {progress.spend.api_calls} / {progress.caps.per_run_calls}
                </span>
              </span>
            ) : progress.spend.api_calls !== null ? (
              <span>
                calls: <span className="text-[#E6EFE8]">{progress.spend.api_calls}</span>
              </span>
            ) : null}
            {progress.spend.tokens_in !== null ? (
              <span>
                tokens:{" "}
                <span className="text-[#E6EFE8]">
                  {progress.spend.tokens_in + (progress.spend.tokens_out ?? 0)}
                </span>
                {progress.caps.per_run_tokens !== null
                  ? ` / ${progress.caps.per_run_tokens}`
                  : ""}
              </span>
            ) : null}
            <span>
              spend: <span className="text-[#E6EFE8]">{money(progress.spend.estimated_usd)}</span>
            </span>
          </div>
          {progress.caps.monthly_calls !== null ? (
            <span className="block font-mono text-[10px] text-[#7C93A8]">
              monthly cap: {progress.caps.monthly_calls} calls · {money(progress.caps.monthly_usd)}
            </span>
          ) : null}
          <span className="block font-mono text-[10px] text-[#7C93A8]">
            heartbeat {formatWhen(progress.updated_at, now)}
          </span>
        </div>
      ) : (
        <p className="mt-2 font-mono text-[10px] text-[#7C93A8]">
          No progress checkpoint yet — this job either just started or does not
          report checkpoints; phase and elapsed come from the Actions run.
        </p>
      )}
    </li>
  );
}

function RecentRow({ run, now }: { run: LiveRecentRun; now: number }) {
  const scope =
    run.params.mechanism ??
    run.params.mode ??
    Object.values(run.params)[0] ??
    "—";
  return (
    <li className="border-t border-[#243329] py-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono text-[10px] uppercase tracking-wider"
            style={{ color: STATUS_COLOR[run.status] ?? "#8CA495" }}
          >
            {run.status}
          </span>
          <span className="font-mono text-[12px] text-[#E6EFE8]">{run.corpus}</span>
          <span className="font-mono text-[11px] text-[#8CA495]">{scope}</span>
        </div>
        <span className="font-mono text-[10px] text-[#7C93A8]">
          {formatWhen(run.timestamp, now)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#8CA495]">
        <span>records: <span className="text-[#E6EFE8]">{run.records}</span></span>
        {run.apiCalls !== null ? (
          <span>calls: <span className="text-[#E6EFE8]">{run.apiCalls}</span></span>
        ) : null}
        <span>cost: <span className="text-[#E6EFE8]">{money(run.estimatedUsd)}</span></span>
        <span>{Math.round(run.durationS)}s</span>
      </div>
      {run.saturation ? (
        <p className="mt-1 font-mono text-[10px] text-[#7C93A8]">{run.saturation}</p>
      ) : null}
      {run.warnings.length > 0 ? (
        <p className="mt-1 font-mono text-[10px] text-[#E4B54E]">
          {run.warnings.join(" · ")}
        </p>
      ) : null}
    </li>
  );
}

function ScheduledRow({ item, now }: { item: LiveScheduledRun; now: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 border-t border-[#243329] py-2 first:border-t-0 first:pt-0">
      <div>
        <span className="font-mono text-[12px] text-[#E6EFE8]">{item.label}</span>
        <span className="ml-2 font-mono text-[10px] text-[#7C93A8]">{item.cron}</span>
      </div>
      <span className="font-mono text-[11px] text-[#7C93A8]">
        {item.nextRunAt ? formatWhen(item.nextRunAt, now) : "—"}
      </span>
    </li>
  );
}

function QueueTile({
  label,
  count,
  href,
  sub,
}: {
  label: string;
  count: number;
  href?: string;
  sub?: string;
}) {
  const body = (
    <div className="rounded-md border border-[#243329] bg-[#0E1512] p-3">
      <div className="font-mono text-2xl text-[#E6EFE8]">{count}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
        {label}
      </div>
      {sub ? <div className="mt-0.5 font-mono text-[10px] text-[#8CA495]">{sub}</div> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-colors hover:border-[#34D399]/50">
      {body}
    </Link>
  ) : (
    body
  );
}

export default function LiveOpsPanel({
  initialSnapshot,
}: {
  initialSnapshot: LiveOpsSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<LiveOpsSnapshot>(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await getLiveOpsSnapshotAction();
      setSnapshot(next);
      setNow(Date.now());
    } catch {
      // Keep the last good snapshot; the next tick retries.
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Poll faster while a job is running, slower when idle. Reschedule whenever
  // the running set changes so a just-started job speeds the cadence up.
  const runningCount = snapshot.running.length;
  useEffect(() => {
    const intervalMs = runningCount > 0 ? 15_000 : 60_000;
    timer.current = setTimeout(function tick() {
      void refresh();
      timer.current = setTimeout(tick, intervalMs);
    }, intervalMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh, runningCount]);

  // Fetch once on mount so the live section fills in past the file-only initial.
  useEffect(() => {
    void refresh();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [refresh]);

  const { queues } = snapshot;

  return (
    <div className="mt-8 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight text-[#E6EFE8]">
          Live operations
        </h2>
        <span className="font-mono text-[10px] text-[#7C93A8]">
          {refreshing ? "refreshing…" : `updated ${formatWhen(snapshot.generatedAt, now)}`}
        </span>
      </div>

      <Panel
        title="Running now"
        hint={runningCount > 0 ? `${runningCount} active` : undefined}
      >
        {!snapshot.liveEnabled ? (
          <EmptyState>
            Live run tracking needs the GitHub read surface. Set{" "}
            <span className="font-mono text-[#E6EFE8]">GH_OPS_TOKEN</span> and{" "}
            <span className="font-mono text-[#E6EFE8]">GH_OPS_REPO</span> to see
            in-flight harvest, extraction, and maturation runs here with phase,
            elapsed time, progress against caps, and current spend.
          </EmptyState>
        ) : snapshot.error ? (
          <EmptyState>
            Live runs could not be loaded: {snapshot.error}. Recent runs, queues,
            and the schedule below are read from committed files and stay current.
          </EmptyState>
        ) : runningCount === 0 ? (
          <EmptyState>
            Nothing running right now. A dispatched harvest or extraction, or a
            scheduled job, appears here within a minute — with its phase, elapsed
            time, query/batch progress, and spend, refreshed from the
            <span className="font-mono"> ops-progress</span> heartbeat every ~2 min.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {snapshot.running.map((run) => (
              <RunningCard key={run.runId} run={run} now={now} />
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Recent runs">
          {snapshot.recent.length === 0 ? (
            <EmptyState>
              Completed runs will appear here from each corpus manifest&apos;s
              run history — outcome, records, cost, and (for evidence) the
              saturation report.
            </EmptyState>
          ) : (
            <ul>
              {snapshot.recent.map((run, index) => (
                <RecentRow key={`${run.corpus}-${run.timestamp}-${index}`} run={run} now={now} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Next scheduled">
          {snapshot.scheduled.length === 0 ? (
            <EmptyState>Scheduled workflows will be listed here.</EmptyState>
          ) : (
            <ul>
              {snapshot.scheduled.map((item) => (
                <ScheduledRow key={`${item.workflow}-${item.cron}`} item={item} now={now} />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Queues">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <QueueTile label="Harvest" count={queues.harvest} sub="research-queue.json" />
          <QueueTile label="Extraction" count={queues.extraction} sub="extraction-queue.json" />
          <QueueTile
            label="Review"
            count={queues.review}
            href="/review"
            sub={queues.reviewHeld > 0 ? `${queues.reviewHeld} held` : "actionable proposals"}
          />
          <QueueTile label="Authoring" count={queues.authoring} sub="owner, in git" />
        </div>
        {queues.checkpointResumes > 0 ? (
          <p className="mt-3 font-mono text-[10px] text-[#E4B54E]">
            {queues.checkpointResumes} evidence checkpoint
            {queues.checkpointResumes === 1 ? "" : "s"} awaiting a continuation dispatch.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
