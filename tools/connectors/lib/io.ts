/**
 * tools/connectors/lib/io.ts — JSON writer and corpus-size guardrail.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A single corpus directory may not exceed 40 MB. Beyond that we are in
 * "corpora arrive (thousands of rows)" territory — the Postgres escalation
 * trigger in docs/architecture.md — and must not silently bloat the repo.
 */
export const MAX_CORPUS_BYTES = 40 * 1024 * 1024;

/** Pretty-printed JSON (2-space indent, trailing newline) for clean git diffs. */
export function writeJsonPretty(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** Total size in bytes of all files under `dir`, recursively. */
export function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
