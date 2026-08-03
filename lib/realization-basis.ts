/**
 * lib/realization-basis.ts — every APPROVED realization for a mechanism,
 * read straight off disk. Mirrors lib/effect-basis.ts's directory-scan
 * pattern; used by the /review DUPLICATE triage flag (lib/review-flags.ts)
 * to compare a candidate realization proposal against what is already
 * authoritative for the same mechanism, never against other pending
 * proposals — only an approved record is a "closest existing record".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Realization } from "./types";

const MECHANISM_ID = /^[A-Z]{2}-\d{2}$/;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every authoritative /realizations/{mechanismId}/*.json record on disk. */
export function listApprovedRealizations(
  mechanismId: string,
  root: string = process.cwd(),
): Realization[] {
  if (!MECHANISM_ID.test(mechanismId)) return [];
  const directory = join(root, "realizations", mechanismId);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .filter(
      (name) => name.endsWith(".json") && name !== "realization.schema.json",
    )
    .sort()
    .map((name) => readJson<Realization>(join(directory, name)))
    .filter((record): record is Realization => record !== null);
}
