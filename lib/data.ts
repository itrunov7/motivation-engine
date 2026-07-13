/**
 * lib/data.ts — typed server-side loaders for the data files (SPEC.md §3).
 *
 * Reads JSON from the repo (the single source of truth, D-001) with node:fs.
 * Server components / static generation only — never shipped to the client.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  DecisionsLog,
  Dossier,
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
  docsDir: join(ROOT, "docs"),
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

/**
 * Dossier records from /dossiers — every .json except the schema itself.
 * Returns [] at baseline (the folder holds only the schema and README),
 * so the /dossiers empty state is computed, never assumed.
 */
export function loadDossiers(): Dossier[] {
  return listJsonFiles(DATA_PATHS.dossiersDir)
    .filter((file) => basename(file) !== "dossier.schema.json")
    .map((file) => readJson<Dossier>(file));
}

// ---------- Foundation documents (/docs, SPEC §3.6) ----------

/** The five foundation documents, in sidebar order (SPEC §3.6). */
export const DOC_SLUGS = [
  "manifesto",
  "ontology-as-science",
  "architecture",
  "runtime-flow",
  "roadmap",
] as const;

export type DocSlug = (typeof DOC_SLUGS)[number];

export interface DocEntry {
  slug: DocSlug;
  /** First `# heading` of the file (the docs carry no frontmatter). */
  title: string;
}

export interface Doc extends DocEntry {
  markdown: string;
}

export function isDocSlug(slug: string): slug is DocSlug {
  return (DOC_SLUGS as readonly string[]).includes(slug);
}

function extractTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

/** Load one foundation document by slug; null for unknown slugs. */
export function loadDoc(slug: string): Doc | null {
  if (!isDocSlug(slug)) return null;
  const file = join(DATA_PATHS.docsDir, `${slug}.md`);
  if (!existsSync(file)) return null;
  const markdown = readFileSync(file, "utf-8");
  return { slug, title: extractTitle(markdown, slug), markdown };
}

/** All five documents (slug + title) for the sidebar nav. */
export function listDocs(): DocEntry[] {
  return DOC_SLUGS.flatMap((slug) => {
    const doc = loadDoc(slug);
    return doc ? [{ slug: doc.slug, title: doc.title }] : [];
  });
}
