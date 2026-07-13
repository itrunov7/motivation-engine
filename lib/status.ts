/**
 * lib/status.ts — the status-computation module (SPEC.md §4, D-005).
 *
 * This is the ONLY file in the codebase where block-status literals
 * ("live" / "in_progress" / "planned") may appear. Every status is computed
 * at render time from the file system and the data files; components receive
 * computed values and map presentation via STATUS_META, never via literals.
 *
 * Computation rules (SPEC §4 "Status computation rules"):
 * - Registry: live if ≥1 valid full mechanism record exists (hard rules:
 *   every implementations[].metrics non-empty AND constraints.hard_rules
 *   non-empty). Count shown as full/total.
 * - Schema & validator: live if the schema files AND the CI workflow exist.
 * - Card generator: live if /cards contains a generated {id}.md for a valid
 *   full record (a README alone does not count).
 * - Runtime / corpora / telemetry: planned while their folders hold no data.
 *   README.md, dotfiles, and .gitkeep are never data; a corpus subfolder
 *   only counts if it contains a manifest.json (contract in corpora/README).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_PATHS,
  loadDecisions,
  loadFullMechanisms,
  loadSeedStubs,
  loadSources,
} from "./data";
import type { LifecycleStatus, Mechanism, SourceClassId } from "./types";

// ---------- Status vocabulary ----------

export type BlockStatus = "live" | "in_progress" | "planned";

export interface StatusMeta {
  label: string;
  /** Design-token color (SPEC §4): emerald / amber / slate. */
  color: string;
}

export const STATUS_META: Record<BlockStatus, StatusMeta> = {
  live: { label: "live", color: "#34D399" },
  in_progress: { label: "in progress", color: "#E4B54E" },
  planned: { label: "planned", color: "#7C93A8" },
};

// ---------- Block model ----------

export interface EmptyStateNote {
  /** Which file / pipeline will fill this block (rule 15). */
  filledBy: string;
  /** Phase: July / August / September. */
  phase: string;
}

export interface SystemBlock {
  id: string;
  name: string;
  status: BlockStatus;
  /** Computed detail line, derived from data — never asserted. */
  detail: string;
  /** Designed empty state, shown while the block is not live. */
  emptyState?: EmptyStateNote;
}

// ---------- File-system helpers ----------

/**
 * True only if the directory contains actual data: README.md, dotfiles and
 * .gitkeep never count, and empty subfolders never count. This is what keeps
 * a fake empty folder from turning anything green.
 */
function hasDataFiles(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name.toUpperCase() === "README.MD") continue;
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasDataFiles(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * Corpus subfolders that satisfy the /corpora contract: named after a source
 * id from the given classes AND containing a manifest.json.
 */
function harvestedCorpora(classIds: SourceClassId[]): string[] {
  const dir = DATA_PATHS.corporaDir;
  if (!existsSync(dir)) return [];
  const sourceIds = new Set(
    loadSources()
      .classes.filter((c) => classIds.includes(c.id))
      .flatMap((c) => c.sources.map((s) => s.id)),
  );
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        sourceIds.has(entry.name) &&
        existsSync(join(dir, entry.name, "manifest.json")),
    )
    .map((entry) => entry.name);
}

// ---------- Mechanism validity (hard rules, D-003) ----------

function isValidFullRecord(record: Mechanism): boolean {
  const implsOk =
    Array.isArray(record.implementations) &&
    record.implementations.length > 0 &&
    record.implementations.every(
      (impl) => Array.isArray(impl.metrics) && impl.metrics.length > 0,
    );
  const rulesOk =
    Array.isArray(record.constraints?.hard_rules) &&
    record.constraints.hard_rules.length > 0;
  return implsOk && rulesOk;
}

// ---------- The seven system blocks ----------

export function computeSystemBlocks(): SystemBlock[] {
  const fullRecords = loadFullMechanisms();
  const seedStubs = loadSeedStubs();
  const validFull = fullRecords.filter(isValidFullRecord);
  const totalMechanisms = fullRecords.length + seedStubs.length;

  // 1. Registry
  const registry: SystemBlock = {
    id: "registry",
    name: "Registry",
    status:
      validFull.length > 0
        ? "live"
        : totalMechanisms > 0
          ? "in_progress"
          : "planned",
    detail: `${validFull.length}/${totalMechanisms} full records (rest are seed stubs)`,
    emptyState:
      validFull.length > 0
        ? undefined
        : {
            filledBy: "/registry/mechanisms/*.json entered by the owner",
            phase: "July",
          },
  };

  // 2. Schema & validator
  const schemaFilesExist =
    existsSync(DATA_PATHS.mechanismSchema) &&
    existsSync(DATA_PATHS.dossierSchema);
  const ciExists = existsSync(DATA_PATHS.ciWorkflow);
  const schemaValidator: SystemBlock = {
    id: "schema-validator",
    name: "Schema & validator",
    status: schemaFilesExist && ciExists ? "live" : "planned",
    detail:
      schemaFilesExist && ciExists
        ? "schemas compile in CI on every push"
        : `schemas: ${schemaFilesExist ? "present" : "missing"} · CI workflow: ${ciExists ? "present" : "missing"}`,
    emptyState:
      schemaFilesExist && ciExists
        ? undefined
        : {
            filledBy:
              "/registry/mechanism.schema.json + /dossiers/dossier.schema.json + .github/workflows/validate.yml",
            phase: "July",
          },
  };

  // 3. Card generator
  const validIds = new Set(validFull.map((r) => r.id));
  const generatedCards = existsSync(DATA_PATHS.cardsDir)
    ? readdirSync(DATA_PATHS.cardsDir).filter(
        (name) => name.endsWith(".md") && validIds.has(name.replace(/\.md$/, "")),
      )
    : [];
  const cardGenerator: SystemBlock = {
    id: "card-generator",
    name: "Card generator",
    status: generatedCards.length > 0 ? "live" : "planned",
    detail:
      generatedCards.length > 0
        ? `${generatedCards.length} card${generatedCards.length === 1 ? "" : "s"} generated (${generatedCards.map((c) => c.replace(/\.md$/, "")).join(", ")})`
        : "no generated cards in /cards yet",
    emptyState:
      generatedCards.length > 0
        ? undefined
        : {
            filledBy: "tools/render-cards.ts (npm run cards) → /cards/{id}.md",
            phase: "July",
          },
  };

  // 4. Runtime selection
  const runtimeHasData = hasDataFiles(DATA_PATHS.runtimeDir);
  const runtime: SystemBlock = {
    id: "runtime",
    name: "Runtime selection",
    status: runtimeHasData ? "live" : "planned",
    detail: runtimeHasData
      ? "runtime artifacts present in /runtime"
      : "no engine at baseline — /runtime is empty",
    emptyState: runtimeHasData
      ? undefined
      : {
          filledBy:
            "the future selection engine (mechanism → artifact matching); out of scope for baseline",
          phase: "September",
        },
  };

  // 5. Corpus: interfaces & science (source classes A + B)
  const abCorpora = harvestedCorpora(["A", "B"]);
  const corpusInterfacesScience: SystemBlock = {
    id: "corpus-interfaces-science",
    name: "Corpus: interfaces & science",
    status: abCorpora.length > 0 ? "live" : "planned",
    detail:
      abCorpora.length > 0
        ? `${abCorpora.length} harvested corpora: ${abCorpora.join(", ")}`
        : "no harvested corpora in /corpora (classes A–B)",
    emptyState:
      abCorpora.length > 0
        ? undefined
        : {
            filledBy:
              "source connectors → /corpora/{source_id}/manifest.json (classes A: interfaces, B: science)",
            phase: "August–September",
          },
  };

  // 6. Corpus: reviews (source classes C + D)
  const cdCorpora = harvestedCorpora(["C", "D"]);
  const corpusReviews: SystemBlock = {
    id: "corpus-reviews",
    name: "Corpus: reviews",
    status: cdCorpora.length > 0 ? "live" : "planned",
    detail:
      cdCorpora.length > 0
        ? `${cdCorpora.length} harvested corpora: ${cdCorpora.join(", ")}`
        : "no harvested corpora in /corpora (classes C–D)",
    emptyState:
      cdCorpora.length > 0
        ? undefined
        : {
            filledBy:
              "source connectors → /corpora/{source_id}/manifest.json (classes C: benchmarks, D: non-obvious)",
            phase: "August–September",
          },
  };

  // 7. Telemetry loop
  const telemetryHasData = hasDataFiles(DATA_PATHS.telemetryDir);
  const observedEffectsCount = fullRecords.reduce(
    (n, record) =>
      n +
      record.implementations.reduce(
        (m, impl) => m + (impl.observed_effects?.length ?? 0),
        0,
      ),
    0,
  );
  const telemetry: SystemBlock = {
    id: "telemetry-loop",
    name: "Telemetry loop",
    status: telemetryHasData || observedEffectsCount > 0 ? "live" : "planned",
    detail:
      telemetryHasData || observedEffectsCount > 0
        ? `${observedEffectsCount} observed effects recorded`
        : "no measured effects yet — observed_effects empty across all records",
    emptyState:
      telemetryHasData || observedEffectsCount > 0
        ? undefined
        : {
            filledBy:
              "product telemetry (me:{id}:{implementation_id} tags) → implementations[].observed_effects",
            phase: "September",
          },
  };

  return [
    registry,
    schemaValidator,
    cardGenerator,
    runtime,
    corpusInterfacesScience,
    corpusReviews,
    telemetry,
  ];
}

// ---------- Live counts ----------

export interface SystemCounts {
  mechanismsByLifecycle: { status: LifecycleStatus; count: number }[];
  mechanismsTotal: number;
  sourcesByStatus: { status: string; count: number }[];
  sourcesTotal: number;
  decisionsCount: number;
}

const LIFECYCLE_ORDER: LifecycleStatus[] = [
  "candidate",
  "incubating",
  "core",
  "deprecated",
  "rejected",
];

export function computeCounts(): SystemCounts {
  const fullRecords = loadFullMechanisms();
  const seedStubs = loadSeedStubs();
  const lifecycleCounts = new Map<LifecycleStatus, number>();
  for (const record of [...fullRecords, ...seedStubs]) {
    lifecycleCounts.set(
      record.lifecycle_status,
      (lifecycleCounts.get(record.lifecycle_status) ?? 0) + 1,
    );
  }

  const sources = loadSources().classes.flatMap((c) => c.sources);
  const sourceCounts = new Map<string, number>();
  for (const source of sources) {
    sourceCounts.set(source.status, (sourceCounts.get(source.status) ?? 0) + 1);
  }

  return {
    mechanismsByLifecycle: LIFECYCLE_ORDER.filter((s) =>
      lifecycleCounts.has(s),
    ).map((status) => ({ status, count: lifecycleCounts.get(status)! })),
    mechanismsTotal: fullRecords.length + seedStubs.length,
    sourcesByStatus: Array.from(sourceCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => ({
        status: status.replace(/_/g, " "),
        count,
      })),
    sourcesTotal: sources.length,
    decisionsCount: loadDecisions().decisions.length,
  };
}
