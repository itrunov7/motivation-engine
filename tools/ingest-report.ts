/**
 * tools/ingest-report.ts — normalizer for report-mode sources (D-029).
 *
 * Report sources (connection_mode "report" in sources.json) are NOT
 * connectors: the numbers live in a published PDF/report that a human
 * downloads and reads, so there is nothing to fetch. This tool is the other
 * half — the owner prepares a small table (csv / json / md), and the tool
 * validates its shape and writes it into the benchmarks corpus so the
 * showcase can flip the source to "ingested" (computed, never stored —
 * lib/status.ts computeSourceState) and the future effects table can back
 * its baseline column with it.
 *
 * Usage: npm run ingest -- <source_id> <file.(csv|json|md)> [retrieved=YYYY-MM-DD]
 *   e.g. npm run ingest -- revenuecat-report data.csv
 *        npm run ingest -- unbounce-benchmarks table.md retrieved=2026-07-14
 *
 * Output:
 *   /corpora/benchmarks/{source_id}.json  — { source_id, retrieved, metrics[] }
 *   /corpora/benchmarks/manifest.json     — standard corpus manifest (D-020),
 *                                            source_ids accumulating every
 *                                            ingested report source.
 *
 * This tool makes NO network calls and touches ONLY /corpora/benchmarks —
 * sources.json stays git-only (D-013/D-023): status is computed, not written.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { ManifestCost, ManifestRun, RunFile } from "./connectors/types";
import { MAX_CORPUS_BYTES, dirSizeBytes, formatBytes, writeJsonPretty } from "./connectors/lib/io";
import { writeManifest } from "./connectors/lib/manifest";

const ROOT = join(__dirname, "..");
const CORPORA_DIR = join(ROOT, "corpora");
const BENCHMARKS_DIR = join(CORPORA_DIR, "benchmarks");
const SOURCES_FILE = join(ROOT, "sources", "sources.json");

/** The corpus id — equals the directory name under /corpora (D-014). */
const CORPUS_ID = "benchmarks";

/** Bumped when the benchmark record shape changes (D-029). */
const INGESTER_VERSION = "1.0.0";

// ---------- Benchmark record contract (writer side, D-029) ----------
//
// Mirrored read-only in lib/types.ts (BenchmarkFile/BenchmarkMetric); a
// drift guard in tools/validate.ts pins writer -> reader at compile time,
// exactly like the manifest (D-020) and heartbeat (D-021) contracts.

/** One benchmark value extracted from a report. */
export interface BenchmarkMetric {
  /** What is measured, e.g. "trial_to_paid_cvr". */
  metric: string;
  /** The segment the value applies to (app category, industry, pattern). */
  category?: string;
  /** The measured number, as reported. */
  value: number;
  /** Unit of `value`, e.g. "%", "count", "usd". */
  unit: string;
  /** Provenance / caveat, e.g. the report page or the segment definition. */
  notes?: string;
}

/** /corpora/benchmarks/{source_id}.json — one report source's benchmarks. */
export interface BenchmarkFile {
  /** The sources.json id this file was ingested for. */
  source_id: string;
  /** ISO date (YYYY-MM-DD) the owner pulled the numbers from the report. */
  retrieved: string;
  metrics: BenchmarkMetric[];
}

// ---------- CLI ----------

function usage(): never {
  console.error("Usage: npm run ingest -- <source_id> <file.(csv|json|md)> [retrieved=YYYY-MM-DD]");
  console.error("  <source_id>  a sources.json source with connection_mode \"report\"");
  console.error("  <file>       owner-prepared table: .csv (header row), .json (array of rows), or .md (pipe table)");
  console.error("  retrieved    optional ISO date the numbers were read from the report (default: today, UTC)");
  process.exit(1);
}

function fail(message: string): never {
  console.error(`FAILED — ${message}`);
  process.exit(1);
}

interface SourceLike {
  id: string;
  connection_mode: string;
}

/** All sources.json records, flattened across classes. */
function loadSources(): SourceLike[] {
  let parsed: { classes?: { sources?: SourceLike[] }[] };
  try {
    parsed = JSON.parse(readFileSync(SOURCES_FILE, "utf-8")) as typeof parsed;
  } catch (err) {
    fail(`cannot read ${relative(ROOT, SOURCES_FILE)} — ${(err as Error).message}`);
  }
  return (parsed.classes ?? []).flatMap((cls) => cls.sources ?? []);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Parsers: file (csv/json/md) -> raw rows ----------

/** A row as string/number keyed by column name, before shape validation. */
type RawRow = Record<string, string | number | null | undefined>;

/** Split one CSV line into fields, honoring double-quoted fields with commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function parseCsv(text: string): RawRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) fail("csv needs a header row and at least one data row");
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: RawRow = {};
    header.forEach((key, i) => {
      row[key] = cells[i] ?? "";
    });
    return row;
  });
}

function parseJson(text: string): RawRow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`input is not valid JSON — ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) fail("json input must be an array of row objects");
  return data.map((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(`json row ${i + 1} is not an object`);
    }
    return row as RawRow;
  });
}

/** Parse the FIRST GitHub-flavored pipe table in a markdown file. */
function parseMarkdownTable(text: string): RawRow[] {
  const lines = text.split(/\r?\n/);
  const tableLines: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = line.trim().startsWith("|");
    if (isRow) {
      inTable = true;
      tableLines.push(line.trim());
    } else if (inTable) {
      break; // table ended at the first non-pipe line
    }
  }
  if (tableLines.length < 2) fail("no markdown pipe table found (need a header, a separator, and rows)");

  const cells = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = cells(tableLines[0]);
  const isSeparator = (line: string): boolean =>
    cells(line).every((c) => /^:?-{1,}:?$/.test(c));
  const bodyStart = isSeparator(tableLines[1]) ? 2 : 1;
  const bodyLines = tableLines.slice(bodyStart).filter((line) => !isSeparator(line));
  if (bodyLines.length === 0) fail("markdown table has a header but no data rows");

  return bodyLines.map((line) => {
    const values = cells(line);
    const row: RawRow = {};
    header.forEach((key, i) => {
      row[key] = values[i] ?? "";
    });
    return row;
  });
}

function parseFile(file: string): RawRow[] {
  const ext = extname(file).toLowerCase();
  const text = readFileSync(file, "utf-8");
  switch (ext) {
    case ".csv":
      return parseCsv(text);
    case ".json":
      return parseJson(text);
    case ".md":
    case ".markdown":
      return parseMarkdownTable(text);
    default:
      fail(`unsupported extension "${ext}" — use .csv, .json, or .md`);
  }
}

// ---------- Normalize + validate rows -> BenchmarkMetric[] ----------

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

/**
 * Validate the minimal shape and normalize. One bad row aborts the whole
 * run BEFORE any write — a benchmark corpus is either whole or not written.
 * `where` is a human-facing row label (row number in the source file).
 */
function normalizeRow(row: RawRow, where: string): BenchmarkMetric {
  const metric = optionalString(row.metric);
  if (!metric) fail(`${where}: "metric" is empty or missing`);

  const unit = optionalString(row.unit);
  if (!unit) fail(`${where}: "unit" is empty or missing`);

  if (row.value === undefined || row.value === null || String(row.value).trim() === "") {
    fail(`${where}: "value" is empty or missing`);
  }
  const value = typeof row.value === "number" ? row.value : Number(String(row.value).trim());
  if (!Number.isFinite(value)) {
    fail(`${where}: "value" (${JSON.stringify(row.value)}) is not a finite number`);
  }

  const category = optionalString(row.category);
  const notes = optionalString(row.notes);

  return {
    metric,
    ...(category !== undefined ? { category } : {}),
    value,
    unit,
    ...(notes !== undefined ? { notes } : {}),
  };
}

// ---------- Main ----------

function main(): void {
  const [sourceId, file, ...rest] = process.argv.slice(2);
  if (!sourceId || !file) usage();

  // Only key=value extras are accepted; today only `retrieved`.
  let retrieved = todayIso();
  for (const arg of rest) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      console.error(`Invalid param "${arg}" — expected key=value.`);
      usage();
    }
    const key = arg.slice(0, eq);
    const val = arg.slice(eq + 1);
    if (key === "retrieved") retrieved = val;
    else {
      console.error(`Unknown param "${key}".`);
      usage();
    }
  }
  if (!ISO_DATE.test(retrieved)) fail(`retrieved "${retrieved}" is not an ISO date (YYYY-MM-DD)`);

  // The source must exist and be report-mode — ingesting into any other mode
  // would produce a corpus the status computation cannot honestly read.
  const source = loadSources().find((s) => s.id === sourceId);
  if (!source) fail(`"${sourceId}" is not a source in sources.json`);
  if (source.connection_mode !== "report") {
    fail(`source "${sourceId}" is connection_mode "${source.connection_mode}", not "report" — ingest-report only ingests report sources (D-013)`);
  }

  if (!existsSync(file)) fail(`input file "${file}" does not exist`);

  const rawRows = parseFile(file);
  if (rawRows.length === 0) fail("no rows found in the input file");
  const metrics = rawRows.map((row, i) => normalizeRow(row, `row ${i + 1}`));

  mkdirSync(BENCHMARKS_DIR, { recursive: true });

  const benchmark: BenchmarkFile = { source_id: sourceId, retrieved, metrics };
  const dataFileName = `${sourceId}.json`;
  writeJsonPretty(join(BENCHMARKS_DIR, dataFileName), benchmark);

  // Size guardrail (same 40 MB corpus ceiling as connectors) — benchmark
  // tables are tiny, but the check keeps the invariant uniform.
  const corpusBytes = dirSizeBytes(BENCHMARKS_DIR);
  if (corpusBytes > MAX_CORPUS_BYTES) {
    fail(`corpus ${relative(ROOT, BENCHMARKS_DIR)} is ${formatBytes(corpusBytes)}, over the ${formatBytes(MAX_CORPUS_BYTES)} limit`);
  }

  // Accumulate source_ids across every report source ingested into this one
  // benchmarks corpus (D-014): a re-ingest of the same source is idempotent.
  const previousSourceIds = readPreviousSourceIds();
  const sourceIds = Array.from(new Set([...previousSourceIds, sourceId])).sort();

  const cost: ManifestCost = {
    api_calls: 0, // no network — a human downloaded the report
    duration_s: 0,
    tokens_in: null,
    tokens_out: null,
    estimated_usd: 0,
  };
  const run: ManifestRun = {
    timestamp: new Date().toISOString(),
    status: "success",
    params: { source_id: sourceId, file: basename(file), retrieved },
    records_fetched: metrics.length,
    files_written: 1,
    duration_s: 0,
    cost,
  };
  const reportedFiles: RunFile[] = [{ path: dataFileName, records: metrics.length }];

  const manifest = writeManifest(
    { sourceId: CORPUS_ID, sourceIds, connectorVersion: INGESTER_VERSION },
    BENCHMARKS_DIR,
    run,
    reportedFiles,
  );

  console.log(`Ingested ${metrics.length} benchmark${metrics.length === 1 ? "" : "s"} for "${sourceId}"`);
  console.log(`  data:     ${relative(ROOT, join(BENCHMARKS_DIR, dataFileName))}`);
  console.log(`  manifest: ${relative(ROOT, join(BENCHMARKS_DIR, "manifest.json"))} (source_ids: ${manifest.source_ids.join(", ")})`);
  console.log(`  ${formatBytes(corpusBytes)} corpus · retrieved ${retrieved}`);
  console.log(`\nOK — "${sourceId}" will compute as ingested on /sources.`);
}

/** source_ids already recorded in the benchmarks manifest, if any. */
function readPreviousSourceIds(): string[] {
  const manifestPath = join(BENCHMARKS_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as { source_ids?: string[] };
    return parsed.source_ids ?? [];
  } catch {
    return [];
  }
}

main();
