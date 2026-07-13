import Link from "next/link";
import {
  CATEGORY_FLAG_META,
  RUN_STATUS_META,
  computeFileChecklist,
  loadCorpusManifests,
  type CategoryFlag,
  type CorpusEntry,
  type DataFileChecklist,
} from "@/lib/status";
import type { CorpusManifestRun } from "@/lib/types";

export const metadata = {
  title: "Connectors — Motivation Engine",
};

/** Runs shown in the compact per-corpus history list. */
const HISTORY_LIMIT = 5;

// ---------- Formatting (presentation only — nothing here is a status) ----------

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  }
  return `${Math.round(seconds)}s`;
}

function formatParams(params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

// ---------- Small presentational pieces ----------

function RunStatusPill({ status }: { status: CorpusManifestRun["status"] }) {
  const meta = RUN_STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider"
      style={{ color: meta.color, borderColor: `${meta.color}40` }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  );
}

function CategoryChip({ flag }: { flag: CategoryFlag }) {
  const meta = CATEGORY_FLAG_META[flag.state];
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[11px]"
      style={{ color: meta.color, borderColor: `${meta.color}40` }}
      title={`${flag.category}: ${meta.label}`}
    >
      {flag.category}
      <span className="opacity-80">{flag.count ?? "?"}</span>
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[#243329] bg-[#1A2620] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]">
      {children}
    </span>
  );
}

// ---------- Data files with the category checklist ----------

function DataFileRow({ checklist }: { checklist: DataFileChecklist }) {
  const missingMeta = CATEGORY_FLAG_META.missing;
  const unclassifiedMeta = CATEGORY_FLAG_META.unclassified;
  return (
    <tr className="border-b border-[#243329] align-top last:border-b-0">
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#E6EFE8]">
        {checklist.path}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#8CA495]">
        {checklist.records}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#8CA495]">
        {formatBytes(checklist.bytes)}
      </td>
      <td className="px-3 py-2.5">
        {checklist.classified ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1">
              {checklist.flags.map((flag) => (
                <CategoryChip key={flag.category} flag={flag} />
              ))}
            </div>
            {checklist.missing.length > 0 && (
              <p
                className="font-mono text-[11px] uppercase tracking-wider"
                style={{ color: missingMeta.color }}
              >
                {missingMeta.label}: {checklist.missing.join(", ")} — the
                corpus cannot disconfirm what it does not hold
              </p>
            )}
          </div>
        ) : (
          <p
            className="font-mono text-[11px] uppercase tracking-wider"
            style={{ color: unclassifiedMeta.color }}
          >
            {unclassifiedMeta.label} — re-run the evidence connector (v2) to
            classify this file
          </p>
        )}
      </td>
    </tr>
  );
}

// ---------- Per-corpus panel ----------

function CorpusPanel({ entry }: { entry: CorpusEntry }) {
  const { dirName, manifest } = entry;
  const lastRun = manifest.last_run;
  const history = (manifest.run_history ?? []).slice(0, HISTORY_LIMIT);
  const checklists = (manifest.data_files ?? []).map(computeFileChecklist);

  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="font-display text-lg font-medium text-[#E6EFE8]">
            {dirName}
          </h2>
          <span className="font-mono text-[11px] text-[#7C93A8]">
            connector v{manifest.connector_version}
          </span>
          <div className="flex flex-wrap gap-1">
            {manifest.source_ids.map((id) => (
              <Tag key={id}>{id}</Tag>
            ))}
          </div>
        </div>
        <RunStatusPill status={lastRun.status} />
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
        {[
          { label: "last run", value: formatTimestamp(lastRun.timestamp) },
          { label: "duration", value: formatDuration(lastRun.duration_s) },
          { label: "records fetched", value: String(lastRun.records_fetched) },
          { label: "params", value: formatParams(lastRun.params) },
        ].map((row) => (
          <div key={row.label}>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
              {row.label}
            </dt>
            <dd className="mt-0.5 font-mono text-xs text-[#E6EFE8]">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {lastRun.error && (
        <p className="mt-3 text-xs leading-relaxed text-[#E4B54E]">
          <span className="font-mono text-[10px] uppercase tracking-wider">
            error ·{" "}
          </span>
          {lastRun.error}
        </p>
      )}
      {lastRun.warnings && Object.keys(lastRun.warnings).length > 0 && (
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-[#E4B54E]">
          warnings ·{" "}
          {Object.entries(lastRun.warnings)
            .filter(([, value]) => value)
            .map(([key]) => key)
            .join(" · ")}
        </p>
      )}

      <div className="mt-5">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          data files · category checklist
        </h3>
        {checklists.length === 0 ? (
          <div className="mt-2 rounded-md border border-dashed border-[#243329] bg-[#1A2620] px-3 py-2.5">
            <p className="text-xs leading-relaxed text-[#8CA495]">
              No data files yet — the last run wrote nothing to this corpus.
            </p>
          </div>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border border-[#243329]">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#243329] bg-[#1A2620]">
                  {["file", "records", "size", "categories"].map((header) => (
                    <th
                      key={header}
                      className="px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-wider text-[#7C93A8]"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {checklists.map((checklist) => (
                  <DataFileRow key={checklist.path} checklist={checklist} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div className="mt-5">
          <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            run history (last {history.length})
          </h3>
          <ul className="mt-2 flex flex-col gap-1">
            {history.map((run, i) => (
              <li
                key={`${run.timestamp}-${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[#8CA495]"
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: RUN_STATUS_META[run.status].color,
                  }}
                />
                <span className="text-[#E6EFE8]">
                  {formatTimestamp(run.timestamp)}
                </span>
                <span>{RUN_STATUS_META[run.status].label}</span>
                <span>{run.records_fetched} records</span>
                <span>{formatDuration(run.duration_s)}</span>
                <span className="text-[#7C93A8]">
                  {formatParams(run.params)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------- Page ----------

export default function ConnectorsPage() {
  const corpora = loadCorpusManifests();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
        >
          ← control center
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
          Connectors — the corpus cockpit
        </h1>
        <p className="mt-1 text-sm text-[#8CA495]">
          Every harvested corpus under /corpora, read from its manifest.json.
          Completeness is verified structurally (D-019): each evidence file
          carries a five-category checklist — foundational, meta-analysis,
          replication, dissent, recent — and an empty category is flagged red,
          because a corpus that can only confirm is broken.
        </p>
      </header>

      {corpora.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-[#243329] bg-[#151F1A] px-4 py-5">
          <p className="text-sm leading-relaxed text-[#8CA495]">
            <span className="text-[#E6EFE8]">No harvested corpora yet.</span>{" "}
            This cockpit fills when a connector run writes
            /corpora/&#123;corpus&#125;/manifest.json — run{" "}
            <span className="font-mono text-xs text-[#E6EFE8]">
              npm run connector -- evidence mechanism=LA-01
            </span>{" "}
            to harvest the first evidence corpus.
          </p>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
            phase · August
          </p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-5">
          {corpora.map((entry) => (
            <CorpusPanel key={entry.dirName} entry={entry} />
          ))}
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed text-[#8CA495]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          checklist legend ·{" "}
        </span>
        a category chip shows the record count from the manifest; a red flag
        means zero records in that category — a structural gap to close with
        targeted evidence_terms, pinned_evidence, or a re-run; amber means the
        file predates connector v2 and has not been classified yet.
      </p>
    </main>
  );
}
