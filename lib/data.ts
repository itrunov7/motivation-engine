/**
 * lib/data.ts — typed server-side loaders for the data files (SPEC.md §3).
 *
 * Reads JSON from the repo (the single source of truth, D-001) with node:fs.
 * Server components / static generation only — never shipped to the client.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DecisionsLog,
  Mechanism,
  SeedStub,
  SourcesRegistry,
  Taxonomy,
} from "./types";

const ROOT = process.cwd();

export const DATA_PATHS = {
  taxonomy: join(ROOT, "registry", "taxonomy.json"),
  mechanismsDir: join(ROOT, "registry", "mechanisms"),
  seedDir: join(ROOT, "registry", "mechanisms", "_seed"),
  mechanismSchema: join(ROOT, "registry", "mechanism.schema.json"),
  dossierSchema: join(ROOT, "dossiers", "dossier.schema.json"),
  dossiersDir: join(ROOT, "dossiers"),
  sources: join(ROOT, "sources", "sources.json"),
  decisions: join(ROOT, "decisions", "decisions.json"),
  cardsDir: join(ROOT, "cards"),
  corporaDir: join(ROOT, "corpora"),
  runtimeDir: join(ROOT, "runtime"),
  telemetryDir: join(ROOT, "telemetry"),
  ciWorkflow: join(ROOT, ".github", "workflows", "validate.yml"),
} as const;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

export function loadTaxonomy(): Taxonomy {
  return readJson<Taxonomy>(DATA_PATHS.taxonomy);
}

/** Full L1 records from /registry/mechanisms (top level, not _seed/). */
export function loadFullMechanisms(): Mechanism[] {
  return listJsonFiles(DATA_PATHS.mechanismsDir).map((file) =>
    readJson<Mechanism>(file),
  );
}

/** Seed stubs from /registry/mechanisms/_seed. */
export function loadSeedStubs(): SeedStub[] {
  return listJsonFiles(DATA_PATHS.seedDir).map((file) =>
    readJson<SeedStub>(file),
  );
}

export function loadSources(): SourcesRegistry {
  return readJson<SourcesRegistry>(DATA_PATHS.sources);
}

export function loadDecisions(): DecisionsLog {
  return readJson<DecisionsLog>(DATA_PATHS.decisions);
}
