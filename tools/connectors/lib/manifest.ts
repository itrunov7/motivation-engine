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
  type Connector,
  type Manifest,
  type ManifestDataFile,
  type ManifestRun,
  type RunFile,
} from "../types";
import { writeJsonPretty } from "./io";

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
 * counts from what the connector reported (files it did not report this
 * run keep the count from the previous manifest, or 0 if unknown).
 */
function scanDataFiles(
  corpusDir: string,
  reported: RunFile[],
  previous: Manifest | undefined,
): ManifestDataFile[] {
  if (!existsSync(corpusDir)) return [];
  const recordCounts = new Map<string, number>();
  for (const file of previous?.data_files ?? []) recordCounts.set(file.path, file.records);
  for (const file of reported) recordCounts.set(file.path, file.records);

  return listFilesRecursive(corpusDir, corpusDir)
    .filter((path) => path !== "manifest.json")
    .sort()
    .map((path) => ({
      path,
      records: recordCounts.get(path) ?? 0,
      bytes: statSync(join(corpusDir, path)).size,
    }));
}

/** Merge the new run into the manifest and write it to disk. */
export function writeManifest(
  connector: Connector,
  corpusDir: string,
  run: ManifestRun,
  reportedFiles: RunFile[],
): Manifest {
  const manifestPath = join(corpusDir, "manifest.json");
  const previous = readExistingManifest(manifestPath);

  const manifest: Manifest = {
    source_id: connector.sourceId,
    source_ids: connector.sourceIds,
    connector_version: connector.connectorVersion,
    last_run: run,
    run_history: [run, ...(previous?.run_history ?? [])].slice(0, RUN_HISTORY_LIMIT),
    data_files: scanDataFiles(corpusDir, reportedFiles, previous),
  };

  writeJsonPretty(manifestPath, manifest);
  return manifest;
}
