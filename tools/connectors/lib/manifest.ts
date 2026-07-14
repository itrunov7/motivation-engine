/**
 * tools/connectors/lib/manifest.ts — manifest read/merge/write.
 *
 * The manifest is written by the runner on EVERY outcome (including
 * failures) so /corpora always tells the honest truth about the last
 * run. run_history keeps the last RUN_HISTORY_LIMIT runs, newest first.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  RUN_HISTORY_LIMIT,
  type CategoryCounts,
  type Manifest,
  type ManifestDataFile,
  type ManifestRun,
  type RunFile,
} from "../types";
import { writeJsonPretty } from "./io";

/**
 * The manifest identity fields — everything writeManifest needs that is not
 * derived from the run or the disk scan. A connector supplies these (D-012),
 * but so does the report ingester (tools/ingest-report.ts, D-029), which is
 * not a connector: it normalizes owner-prepared files instead of harvesting
 * an API. Decoupling the writer from the Connector interface lets both share
 * one manifest writer (D-020: one manifest contract, one writer).
 */
export interface ManifestIdentity {
  /** The corpus id — equals the directory name under /corpora. */
  sourceId: string;
  /** The sources/sources.json ids this corpus covers (D-014). */
  sourceIds: string[];
  connectorVersion: string;
}

function readExistingManifest(manifestPath: string): Manifest | undefined {
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch {
    // A corrupt manifest must not block the run from recording itself.
    return undefined;
  }
}

function listFilesRecursive(dir: string, base: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(path, base));
    else if (entry.isFile()) files.push(relative(base, path));
  }
  return files;
}

/**
 * Rebuild data_files by scanning the corpus dir: bytes from stat, record
 * counts and category checklists from what the connector reported (files it
 * did not report this run keep the values from the previous manifest — count
 * 0 / no categories if unknown).
 */
function scanDataFiles(
  corpusDir: string,
  reported: RunFile[],
  previous: Manifest | undefined,
): ManifestDataFile[] {
  if (!existsSync(corpusDir)) return [];
  const recordCounts = new Map<string, number>();
  const categoryCounts = new Map<string, CategoryCounts>();
  for (const file of previous?.data_files ?? []) {
    recordCounts.set(file.path, file.records);
    if (file.categories) categoryCounts.set(file.path, file.categories);
  }
  for (const file of reported) {
    recordCounts.set(file.path, file.records);
    if (file.categories) categoryCounts.set(file.path, file.categories);
  }

  return listFilesRecursive(corpusDir, corpusDir)
    .filter((path) => path !== "manifest.json")
    .sort()
    .map((path) => {
      const categories = categoryCounts.get(path);
      return {
        path,
        records: recordCounts.get(path) ?? 0,
        bytes: statSync(join(corpusDir, path)).size,
        ...(categories ? { categories } : {}),
      };
    });
}

/** Merge the new run into the manifest and write it to disk. */
export function writeManifest(
  identity: ManifestIdentity,
  corpusDir: string,
  run: ManifestRun,
  reportedFiles: RunFile[],
): Manifest {
  const manifestPath = join(corpusDir, "manifest.json");
  const previous = readExistingManifest(manifestPath);

  const manifest: Manifest = {
    source_id: identity.sourceId,
    source_ids: identity.sourceIds,
    connector_version: identity.connectorVersion,
    last_run: run,
    run_history: [run, ...(previous?.run_history ?? [])].slice(0, RUN_HISTORY_LIMIT),
    data_files: scanDataFiles(corpusDir, reportedFiles, previous),
  };

  writeJsonPretty(manifestPath, manifest);
  return manifest;
}
