/**
 * tools/validate.ts — repo-wide data validation (SPEC.md §6).
 *
 * Validates:
 * - /registry/mechanisms/*.json against mechanism.schema.json (full records)
 * - /registry/mechanisms/_seed/*.json against the seedStub sub-schema
 * - HARD RULE (checked explicitly on top of the schema): a full record with
 *   empty/missing implementations[].metrics or constraints.hard_rules FAILS
 * - HARD RULE (D-038): a full record with a non-null dossier_ref MUST carry a
 *   non-empty evidence_terms — a dossier'd corpus was built from terms, so a
 *   record that dropped them is non-reproducible (a re-harvest would fall back
 *   to [name] and silently regress the corpus)
 * - /registry/taxonomy.json, /sources/sources.json, /decisions/decisions.json
 * - /dossiers/dossier.schema.json integrity + any dossier records; a dossier
 *   referencing a mechanism whose evidence corpus is missing, unclassified,
 *   or has an empty dissent category FAILS (D-019)
 * - EVERY manifest.json under /corpora, at any depth, against the connector
 *   manifest contract (tools/connectors/types.ts): dir name = source_id,
 *   run_history ≤ 20, data_files exist on disk, every source_ids entry
 *   matches a source id in sources.json, non-"_" dirs harvest ≥1 source
 *   (D-014)
 * - /corpora/_health/heartbeat.json (when present) against the heartbeat
 *   contract (tools/health-check.ts, D-021), with the same drift-guard
 *   pattern pinning writer → reader (lib/types.ts HeartbeatFile)
 * - CONTRACT DRIFT GUARD (D-020): the manifest schema below is key-derived
 *   from the writer contract (tools/connectors/types.ts), and a type-level
 *   assertion pins the writer contract to the reader contract
 *   (lib/types.ts CorpusManifest — what status computation expects). Any
 *   drift between connectors and the showcase fails `npm run build` in CI
 *   instead of silently flipping sources to not_connected.
 * - Cross-references: filename = id, unique ids, parent in taxonomy,
 *   relations[].target in the mechanism roster
 *
 * Non-zero exit on any violation. Run with `npm run validate`.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { Ajv2020, type ValidateFunction, type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import {
  EVIDENCE_CATEGORIES,
  RUN_HISTORY_LIMIT,
  type Manifest,
  type ManifestCost,
  type ManifestDataFile,
  type StoredManifestRun,
} from "./connectors/types";
import type {
  HeartbeatEntry as WriterHeartbeatEntry,
  HeartbeatFile as WriterHeartbeatFile,
} from "./health-check";
import type { BenchmarkFile as WriterBenchmarkFile } from "./ingest-report";
import type {
  OpsBudget as WriterOpsBudget,
  OpsConnectorConfig as WriterOpsConnectorConfig,
  RunQuote as WriterRunQuote,
} from "./connectors/types";
import { CONNECTORS } from "./connectors";
import { deriveCorpusRecordId, CORPUS_RECORD_ID_PATTERN } from "../lib/corpus-record-id";
import type {
  BenchmarkFile,
  BenchmarkMetric,
  CorpusManifest,
  EvidenceCorpusFile,
  HeartbeatFile,
  KnowledgeProvenanceItem,
  OpsBudget,
  OpsConnectorConfig,
  PackMapElement,
  RunQuote,
  Segment,
  SegmentCandidate,
} from "../lib/types";
import {
  KNOWN_CONNECTOR_IDS,
  OPS_PATHS,
  validateExtractionOpsConfig,
  validateOpsBudget,
  validateOpsConnectorConfig,
} from "../lib/ops";

const ROOT = join(__dirname, "..");

const PATHS = {
  mechanismSchema: join(ROOT, "registry", "mechanism.schema.json"),
  mechanismsDir: join(ROOT, "registry", "mechanisms"),
  seedDir: join(ROOT, "registry", "mechanisms", "_seed"),
  taxonomy: join(ROOT, "registry", "taxonomy.json"),
  sources: join(ROOT, "sources", "sources.json"),
  decisions: join(ROOT, "decisions", "decisions.json"),
  dossierSchema: join(ROOT, "dossiers", "dossier.schema.json"),
  dossiersDir: join(ROOT, "dossiers"),
  corporaDir: join(ROOT, "corpora"),
  benchmarksDir: join(ROOT, "corpora", "benchmarks"),
  heartbeat: join(ROOT, "corpora", "_health", "heartbeat.json"),
  segments: join(ROOT, "segments", "segments.yaml"),
  segmentCandidates: join(ROOT, "segments", "candidates.json"),
  packMap: join(ROOT, "packs", "pack-map.yaml"),
  packsDir: join(ROOT, "packs"),
  packBundle: join(ROOT, "packs", "export", "packs-bundle.yaml"),
  interactionSchema: join(ROOT, "interactions", "interaction.schema.json"),
  interactionsDir: join(ROOT, "interactions"),
  effectSchema: join(ROOT, "effects", "effect.schema.json"),
  effectsDir: join(ROOT, "effects"),
  realizationSchema: join(ROOT, "realizations", "realization.schema.json"),
  realizationsDir: join(ROOT, "realizations"),
  proposalSchema: join(ROOT, "proposals", "proposal.schema.json"),
  proposalsDir: join(ROOT, "proposals"),
};

/** /corpora dirs that are ops surfaces, not harvested corpora — no manifest. */
const NON_CORPUS_DIRS = new Set(["_health", "_ops"]);

let errorCount = 0;

function rel(path: string): string {
  return relative(ROOT, path);
}

function fail(file: string, message: string): void {
  errorCount++;
  console.error(`  ✗ ${rel(file)}: ${message}`);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`,
  );
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    fail(file, `not valid JSON — ${(err as Error).message}`);
    return undefined;
  }
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function listJsonFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFilesRecursive(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

/** Every manifest.json under `dir` at any depth (D-020), sorted. */
function findManifestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findManifestFiles(full));
    else if (entry.isFile() && entry.name === "manifest.json") found.push(full);
  }
  return found.sort();
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);

// ---------- Inline schemas mirroring SPEC.md §3.1 / §3.4 / §3.5 ----------

const taxonomySchema = {
  type: "object",
  properties: {
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    nodes: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^S[1-7]$" },
          name: { type: "string", minLength: 1 },
          anchors: {
            type: "object",
            properties: {
              rdoc: { type: "string", minLength: 1 },
              panksepp: { type: "string", minLength: 1 },
            },
            required: ["rdoc"],
            additionalProperties: false,
          },
          description: { type: "string", minLength: 1 },
          cross_cutting: { type: "boolean" },
        },
        required: ["id", "name", "anchors", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "nodes"],
  additionalProperties: false,
} as const;

const sourcesSchema = {
  type: "object",
  properties: {
    classes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", enum: ["A", "B", "C", "D"] },
          name: { type: "string", minLength: 1 },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", pattern: "^[a-z0-9-]+$" },
                name: { type: "string", minLength: 1 },
                what: { type: "string", minLength: 1 },
                access: {
                  type: "string",
                  enum: [
                    "open",
                    "free",
                    "freemium",
                    "registration",
                    "subscription",
                    "mixed",
                    "internal (Amplitude export)",
                    "public archives (failure story collections, Indie Hackers)",
                    "subscription/free galleries",
                    "academic literature via evidence connector + curated reports",
                  ],
                },
                api: { type: "boolean" },
                cost: { type: "string", minLength: 1 },
                priority: { type: "string", enum: ["P0", "P1", "P2"] },
                phase: { type: "string", minLength: 1 },
                connection_mode: {
                  type: "string",
                  enum: ["api", "internal", "report", "manual", "deferred"],
                },
                mode_note: { type: "string", minLength: 1 },
                feeds: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "string",
                    enum: ["L0", "L1", "L2", "L3", "dossiers", "effects", "weights", "constraints"],
                  },
                },
                legal_note: { type: "string", minLength: 1 },
              },
              required: ["id", "name", "what", "access", "api", "cost", "priority", "phase", "connection_mode", "feeds"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "name", "sources"],
        additionalProperties: false,
      },
    },
  },
  required: ["classes"],
  additionalProperties: false,
} as const;

const decisionsSchema = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^D-\\d{3}$" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          area: {
            type: "string",
            enum: ["architecture", "data", "process", "stack", "operations"],
          },
        },
        required: ["id", "date", "title", "body", "area"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
} as const;

// ---------- Product segments (D-047) ----------
//
// /segments/segments.yaml is the product-segment axis — first-class,
// evolving system data classifying the OUTPUT products Ventora builds. The
// Ajv schema property keys are pinned to the reader contract (lib/types.ts
// Segment) via a satisfies constraint, so a field renamed/added/removed on
// the type without a schema update no longer compiles.
const segmentProperties = {
  id: { type: "string", pattern: "^[a-z0-9-]+$" },
  group: {
    type: "string",
    enum: ["business-model", "form", "audience", "usage-rhythm"],
  },
  definition: { type: "string", minLength: 1 },
  status: { type: "string", enum: ["active", "retired"] },
  provenance: { type: "string", pattern: "^(seed-\\d{4}-\\d{2}|analyzer|owner)$" },
} as const satisfies Record<keyof Segment, unknown>;

const segmentsSchema = {
  type: "object",
  properties: {
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    segments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: segmentProperties,
        required: [
          "id",
          "group",
          "definition",
          "status",
          "provenance",
        ] satisfies readonly (keyof Segment)[],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "segments"],
  additionalProperties: false,
} as const;

// ---------- Segment candidates (D-054) ----------
//
// /segments/candidates.json is the owner-approval queue for analyzer-proposed
// segments — the discovery analog of the mechanism seed stubs. Written by the
// (designed, not yet scheduled) tools/segment-suggest.ts; the owner promotes a
// candidate by hand-adding it to segments.yaml with provenance "analyzer". The
// Ajv schema keys are pinned to the reader contract (lib/types.ts
// SegmentCandidate) via a satisfies constraint, same drift-guard as segments.
const segmentCandidateProperties = {
  id: { type: "string", pattern: "^[a-z0-9-]+$" },
  group: {
    type: "string",
    enum: ["business-model", "form", "audience", "usage-rhythm"],
  },
  definition_draft: { type: "string", minLength: 1 },
  evidence_note: { type: "string", minLength: 1 },
  proposed_at: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["proposed", "approved", "rejected"] },
} as const satisfies Record<keyof SegmentCandidate, unknown>;

const segmentCandidatesSchema = {
  type: "object",
  properties: {
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    generated_at: { type: ["string", "null"], format: "date-time" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: segmentCandidateProperties,
        required: [
          "id",
          "group",
          "definition_draft",
          "evidence_note",
          "proposed_at",
          "status",
        ] satisfies readonly (keyof SegmentCandidate)[],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "generated_at", "candidates"],
  additionalProperties: false,
} as const;

// ---------- Pack map (D-048) ----------
//
// /packs/pack-map.yaml is the ONE hand-authored input to pack generation:
// which mechanisms' evidence is relevant to which Development-Plan element
// type. Everything downstream (packs) is a computed projection. The Ajv
// schema property keys are pinned to the reader contract (lib/types.ts
// PackMapElement) via a satisfies constraint, so a field renamed/added/removed
// on the type without a schema update no longer compiles. The mechanism-id
// cross-check (every id resolves to a registry record) runs in the pass below,
// once the roster is built.
const packMapElementProperties = {
  id: { type: "string", pattern: "^[a-z0-9-]+$" },
  applies_to: {
    type: "array",
    minItems: 1,
    items: { type: "string", pattern: "^[a-z0-9-]+$" },
  },
  funnel_stage: {
    type: "string",
    enum: [
      "cold_acquisition",
      "onboarding",
      "activation",
      "conversion",
      "retention",
      "reactivation",
    ],
  },
  mechanisms: {
    type: "array",
    minItems: 1,
    items: { type: "string", pattern: "^[A-Z]{2}-\\d{2}$" },
  },
  note: { type: "string", minLength: 1 },
} as const satisfies Record<keyof PackMapElement, unknown>;

const packMapSchema = {
  type: "object",
  properties: {
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    elements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: packMapElementProperties,
        required: [
          "id",
          "applies_to",
          "funnel_stage",
          "mechanisms",
        ] satisfies readonly (keyof PackMapElement)[],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "elements"],
  additionalProperties: false,
} as const;

// ---------- Manifest contract drift guards (D-020) ----------
//
// The manifest contract exists in three places: the writer
// (tools/connectors/types.ts `Manifest`), the reader the showcase computes
// source states from (lib/types.ts `CorpusManifest`), and the Ajv schema
// below. The assertions here turn any drift between them into a compile
// error — `npm run build` in CI goes red instead of production sources
// silently flipping to not_connected.

/** Compiles only while the writer contract satisfies the reader contract. */
type AssertAssignable<Writer extends Reader, Reader> = Writer;

// Connector output must remain readable by lib/status.ts computations.
type _ManifestContractInSync = AssertAssignable<Manifest, CorpusManifest>;

// Schema property/required keys are checked against the writer contract:
// a field renamed, removed, or added in tools/connectors/types.ts without a
// schema update no longer compiles.
// Cost accounting block (D-022): api_calls and duration filled by connectors
// now; tokens reserved for future LLM jobs (number OR null); estimated_usd
// computed. Optional on the run — runs recorded before D-022 carry no block —
// but when present every key is required and no extras are allowed.
const manifestCostProperties = {
  api_calls: { type: "integer", minimum: 0 },
  duration_s: { type: "number", minimum: 0 },
  tokens_in: { type: ["integer", "null"], minimum: 0 },
  tokens_out: { type: ["integer", "null"], minimum: 0 },
  estimated_usd: { type: "number", minimum: 0 },
} as const satisfies Record<keyof ManifestCost, unknown>;

const manifestCostSchema = {
  type: "object",
  properties: manifestCostProperties,
  required: [
    "api_calls",
    "duration_s",
    "tokens_in",
    "tokens_out",
    "estimated_usd",
  ] satisfies readonly (keyof ManifestCost)[],
  additionalProperties: false,
} as const;

const manifestRunProperties = {
  timestamp: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["success", "partial", "failed"] },
  params: { type: "object", additionalProperties: { type: "string" } },
  records_fetched: { type: "integer", minimum: 0 },
  files_written: { type: "integer", minimum: 0 },
  duration_s: { type: "number", minimum: 0 },
  error: { type: "string", minLength: 1 },
  warnings: { type: "object", additionalProperties: { type: "boolean" } },
  cost: manifestCostSchema,
} as const satisfies Record<keyof StoredManifestRun, unknown>;

const manifestRunRequired = [
  "timestamp",
  "status",
  "params",
  "records_fetched",
  "files_written",
  "duration_s",
] as const satisfies readonly (keyof StoredManifestRun)[];

const manifestRunSchema = {
  type: "object",
  properties: manifestRunProperties,
  required: manifestRunRequired,
  additionalProperties: false,
} as const;

// Per-file category checklist counts (D-019): exactly the five categories
// (imported from the connector contract — no local mirror), each a
// non-negative integer. Optional — files harvested by pre-v2 connectors
// carry no categories.
const categoryCountsSchema = {
  type: "object",
  properties: Object.fromEntries(
    EVIDENCE_CATEGORIES.map((category) => [
      category,
      { type: "integer", minimum: 0 },
    ]),
  ),
  required: [...EVIDENCE_CATEGORIES],
  additionalProperties: false,
} as const;

const manifestDataFileProperties = {
  path: { type: "string", minLength: 1 },
  records: { type: "integer", minimum: 0 },
  bytes: { type: "integer", minimum: 0 },
  categories: categoryCountsSchema,
} as const satisfies Record<keyof ManifestDataFile, unknown>;

const corpusManifestProperties = {
  source_id: { type: "string", pattern: "^_?[a-z0-9-]+$" },
  source_ids: {
    type: "array",
    items: { type: "string", pattern: "^[a-z0-9-]+$" },
  },
  connector_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
  last_run: manifestRunSchema,
  run_history: {
    type: "array",
    minItems: 1,
    maxItems: RUN_HISTORY_LIMIT,
    items: manifestRunSchema,
  },
  data_files: {
    type: "array",
    items: {
      type: "object",
      properties: manifestDataFileProperties,
      required: ["path", "records", "bytes"] satisfies readonly (keyof ManifestDataFile)[],
      additionalProperties: false,
    },
  },
} as const satisfies Record<keyof Manifest, unknown>;

const corpusManifestRequired = [
  "source_id",
  "source_ids",
  "connector_version",
  "last_run",
  "run_history",
  "data_files",
] as const satisfies readonly (keyof Manifest)[];

const corpusManifestSchema = {
  type: "object",
  properties: corpusManifestProperties,
  required: corpusManifestRequired,
  additionalProperties: false,
} as const;

// ---------- Heartbeat contract drift guards (D-021, same pattern as D-020) ----------
//
// The heartbeat contract exists in three places: the writer
// (tools/health-check.ts), the reader the showcase computes health from
// (lib/types.ts HeartbeatFile), and the Ajv schema below. The assertions
// pin them to each other at compile time.

// Health-check output must remain readable by lib/status.ts computations.
type _HeartbeatContractInSync = AssertAssignable<WriterHeartbeatFile, HeartbeatFile>;

// Ops config drift guards (D-024, same pattern): the write-path/tooling
// contract (tools/connectors/types.ts) must stay assignable to the reader the
// app and lib/ops.ts compute from (lib/types.ts).
type _OpsBudgetInSync = AssertAssignable<WriterOpsBudget, OpsBudget>;
type _OpsConnectorConfigInSync = AssertAssignable<WriterOpsConnectorConfig, OpsConnectorConfig>;
type _RunQuoteInSync = AssertAssignable<WriterRunQuote, RunQuote>;

// Benchmark ingester output (D-029) must remain readable by the showcase /
// future effects-table baseline column (lib/types.ts BenchmarkFile).
type _BenchmarkContractInSync = AssertAssignable<WriterBenchmarkFile, BenchmarkFile>;

const heartbeatEntryProperties = {
  source_id: { type: "string", pattern: "^[a-z0-9-]+$" },
  checked_at: { type: "string", format: "date-time" },
  status: {
    type: "string",
    enum: ["ok", "degraded", "down", "unknown", "n_a"],
  },
  latency_ms: { type: ["integer", "null"], minimum: 0 },
  note: { type: "string", minLength: 1 },
} as const satisfies Record<keyof WriterHeartbeatEntry, unknown>;

const heartbeatEntryRequired = [
  "source_id",
  "checked_at",
  "status",
  "latency_ms",
  "note",
] as const satisfies readonly (keyof WriterHeartbeatEntry)[];

const heartbeatSchema = {
  type: "object",
  properties: {
    generated_at: { type: "string", format: "date-time" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: heartbeatEntryProperties,
        required: heartbeatEntryRequired,
        additionalProperties: false,
      },
    },
  } satisfies Record<keyof WriterHeartbeatFile, unknown>,
  required: ["generated_at", "entries"] satisfies readonly (keyof WriterHeartbeatFile)[],
  additionalProperties: false,
} as const;

// ---------- Benchmark file contract (D-029) ----------
//
// /corpora/benchmarks/{source_id}.json is owner-prepared data normalized by
// tools/ingest-report.ts. The manifest is already validated by the corpus
// pass; here we additionally check the benchmark RECORD shape so a malformed
// baseline can never enter the repo. metric/unit non-empty, value a finite
// number (JSON cannot express NaN/Infinity), category/notes optional.
const benchmarkMetricSchema = {
  type: "object",
  properties: {
    metric: { type: "string", minLength: 1 },
    category: { type: "string", minLength: 1 },
    value: { type: "number" },
    unit: { type: "string", minLength: 1 },
    notes: { type: "string", minLength: 1 },
  } satisfies Record<keyof BenchmarkMetric, unknown>,
  required: ["metric", "value", "unit"] satisfies readonly (keyof BenchmarkMetric)[],
  additionalProperties: false,
} as const;

const benchmarkFileSchema = {
  type: "object",
  properties: {
    source_id: { type: "string", pattern: "^[a-z0-9-]+$" },
    retrieved: { type: "string", format: "date" },
    metrics: { type: "array", minItems: 1, items: benchmarkMetricSchema },
  } satisfies Record<keyof BenchmarkFile, unknown>,
  required: ["source_id", "retrieved", "metrics"] satisfies readonly (keyof BenchmarkFile)[],
  additionalProperties: false,
} as const;

// ---------- Evidence diversity report (D-058) ----------
//
// A harvested corpus (corpora/evidence/{id}.json) carries a diversity_report
// written by the evidence connector: viewpoint spread (per angle), source
// spread (per API), recency, and a novelty block whose low_novelty boolean
// tells the maturation loop whether the harvest re-fetched the same canon. The
// report is ADDITIVE — a file harvested before D-058 has none and stays valid —
// but a file that DOES carry one must carry a well-formed one, so a malformed
// report can never mislead the loop's progress accounting.
const EVIDENCE_ANGLE_IDS = [
  "canon",
  "recent",
  "application",
  "critique",
  "replication",
  "boundary",
  "cross-domain",
];
const SEARCH_API_IDS = ["openalex", "semantic-scholar"];

const spreadCounts = {
  queries: { type: "integer", minimum: 0 },
  returned: { type: "integer", minimum: 0 },
  unique_records: { type: "integer", minimum: 0 },
} as const;

const diversityReportSchema = {
  type: "object",
  properties: {
    viewpoint_spread: {
      type: "array",
      items: {
        type: "object",
        properties: {
          angle: { type: "string", enum: EVIDENCE_ANGLE_IDS },
          ...spreadCounts,
        },
        required: ["angle", "queries", "returned", "unique_records"],
        additionalProperties: false,
      },
    },
    source_spread: {
      type: "array",
      items: {
        type: "object",
        properties: {
          api: { type: "string", enum: SEARCH_API_IDS },
          ...spreadCounts,
        },
        required: ["api", "queries", "returned", "unique_records"],
        additionalProperties: false,
      },
    },
    recent_records: { type: "integer", minimum: 0 },
    recency_rate: { type: "number", minimum: 0, maximum: 1 },
    novelty: {
      type: "object",
      properties: {
        previous_corpus_records: { type: ["integer", "null"], minimum: 0 },
        unique_records: { type: "integer", minimum: 0 },
        already_in_corpus: { type: "integer", minimum: 0 },
        new_records: { type: "integer", minimum: 0 },
        novelty_rate: { type: "number", minimum: 0, maximum: 1 },
        low_novelty: { type: "boolean" },
        known_share_threshold: { type: "number", minimum: 0, maximum: 1 },
      },
      required: [
        "previous_corpus_records",
        "unique_records",
        "already_in_corpus",
        "new_records",
        "novelty_rate",
        "low_novelty",
        "known_share_threshold",
      ],
      additionalProperties: false,
    },
  },
  required: ["viewpoint_spread", "source_spread", "recent_records", "recency_rate", "novelty"],
  additionalProperties: false,
} as const;

// ---------- Validation passes ----------

interface MechanismLike {
  id?: string;
  parent?: string;
  dossier_ref?: string | null;
  evidence_terms?: unknown;
  effect_refs?: unknown;
  implementations?: {
    id?: string;
    effect_id?: string;
    realization_ids?: unknown;
    metrics?: unknown;
  }[];
  constraints?: { hard_rules?: unknown };
  relations?: { target?: string }[];
}

/**
 * D-019: a dossier referencing a mechanism whose evidence file has an empty
 * dissent category FAILS validation — a corpus that can only confirm is
 * broken. Missing or unclassified (pre-v2) evidence files fail too, because
 * their dissent coverage cannot be verified.
 */
function checkDossierDissent(dossierFile: string, mechanismId: string): boolean {
  const evidenceFile = join(PATHS.corporaDir, "evidence", `${mechanismId}.json`);
  if (!existsSync(evidenceFile)) {
    fail(
      dossierFile,
      `no evidence corpus for "${mechanismId}" (expected ${rel(evidenceFile)}) — a dossier cannot rest on an unharvested corpus (D-019)`,
    );
    return false;
  }
  let evidence: { category_counts?: Record<string, number> };
  try {
    evidence = JSON.parse(readFileSync(evidenceFile, "utf-8")) as {
      category_counts?: Record<string, number>;
    };
  } catch (err) {
    fail(
      dossierFile,
      `evidence corpus ${rel(evidenceFile)} is not valid JSON — ${(err as Error).message}`,
    );
    return false;
  }
  const dissent = evidence.category_counts?.dissent;
  if (typeof dissent !== "number") {
    fail(
      dossierFile,
      `evidence corpus for "${mechanismId}" has no category checklist — re-run the evidence connector (v2, D-019)`,
    );
    return false;
  }
  if (dissent === 0) {
    fail(
      dossierFile,
      `corpus for "${mechanismId}" has an empty dissent category — a corpus that can only confirm is broken (D-019)`,
    );
    return false;
  }
  return true;
}

function validateAgainst(
  validate: ValidateFunction,
  file: string,
  data: unknown,
): boolean {
  if (validate(data)) return true;
  for (const message of formatAjvErrors(validate.errors)) {
    fail(file, message);
  }
  return false;
}

function main(): void {
  console.log("Motivation Engine validator\n");

  // 1. Compile the mechanism schema (full + seed sub-schema).
  const mechanismSchema = readJson(PATHS.mechanismSchema);
  if (mechanismSchema === undefined) return finish();
  let validateFull: ValidateFunction;
  let validateSeed: ValidateFunction;
  try {
    validateFull = ajv.compile(mechanismSchema as object);
    const schemaId = (mechanismSchema as { $id: string }).$id;
    const seed = ajv.getSchema(`${schemaId}#/$defs/seedStub`);
    if (!seed) throw new Error("$defs.seedStub not found in mechanism.schema.json");
    validateSeed = seed;
  } catch (err) {
    fail(PATHS.mechanismSchema, `schema does not compile — ${(err as Error).message}`);
    return finish();
  }
  console.log(`  ✓ ${rel(PATHS.mechanismSchema)} compiles (full record + seedStub)`);

  // 2. Taxonomy (needed for cross-checks below).
  const taxonomy = readJson(PATHS.taxonomy) as
    | { nodes?: { id: string; cross_cutting?: boolean }[] }
    | undefined;
  const taxonomyIds = new Set<string>();
  // L0 nodes flagged cross_cutting (D-062): their mechanisms are emitted into
  // every pack automatically and must NOT be listed per element in the pack map
  // (D-066).
  const crossCuttingL0 = new Set<string>();
  if (taxonomy !== undefined && validateAgainst(ajv.compile(taxonomySchema), PATHS.taxonomy, taxonomy)) {
    for (const node of taxonomy.nodes ?? []) {
      taxonomyIds.add(node.id);
      if (node.cross_cutting) crossCuttingL0.add(node.id);
    }
    if (taxonomyIds.size !== 7) {
      fail(PATHS.taxonomy, `expected 7 unique node ids S1–S7, found ${taxonomyIds.size}`);
    } else {
      console.log(`  ✓ ${rel(PATHS.taxonomy)} valid (${taxonomyIds.size} L0 nodes)`);
    }
  }

  // 3. Full mechanism records.
  const fullFiles = listJsonFiles(PATHS.mechanismsDir);
  const rosterIds = new Map<string, string>(); // id -> file
  const parentById = new Map<string, string>(); // id -> L0 parent (full + seed)
  const fullRecords: { file: string; record: MechanismLike }[] = [];

  for (const file of fullFiles) {
    const data = readJson(file);
    if (data === undefined) continue;
    const record = data as MechanismLike;

    const schemaOk = validateAgainst(validateFull, file, data);

    // HARD RULE — checked explicitly so it fails loudly even if the schema
    // were ever weakened (SPEC §3.2, .cursorrules invariant 4, D-003).
    let hardRulesOk = true;
    const impls = Array.isArray(record.implementations) ? record.implementations : [];
    impls.forEach((impl, i) => {
      const metrics = impl?.metrics;
      if (!Array.isArray(metrics) || metrics.length === 0) {
        fail(
          file,
          `HARD RULE violated: implementations[${i}] (${impl?.id ?? "?"}) has empty or missing metrics — a mechanism we cannot measure is not knowledge`,
        );
        hardRulesOk = false;
      }
    });
    const hardRules = record.constraints?.hard_rules;
    if (!Array.isArray(hardRules) || hardRules.length === 0) {
      fail(
        file,
        "HARD RULE violated: constraints.hard_rules is empty or missing — a mechanism without guardrails is a dark-pattern risk",
      );
      hardRulesOk = false;
    }

    // HARD RULE — corpus reproducibility (D-038): a record with a dossier rests
    // on a harvested corpus (D-019), and that corpus was built from the
    // record's evidence_terms (D-015). A dossier'd mechanism that has dropped
    // its terms is non-reproducible — a re-harvest would silently fall back to
    // [name] and regress the corpus. Terms MUST live on the full record, not
    // only on the (deleted-at-admission) seed stub.
    if (typeof record.dossier_ref === "string" && record.dossier_ref.length > 0) {
      const terms = record.evidence_terms;
      if (!Array.isArray(terms) || terms.length === 0) {
        fail(
          file,
          "HARD RULE violated: record has a dossier_ref but no evidence_terms — a dossier'd corpus was built from terms; without them the corpus is non-reproducible and a re-harvest silently regresses it (D-038)",
        );
        hardRulesOk = false;
      }
    }

    if (typeof record.id === "string") {
      const expected = `${record.id}.json`;
      if (!file.endsWith(`/${expected}`)) {
        fail(file, `filename does not match record id "${record.id}" (expected ${expected})`);
      }
      if (rosterIds.has(record.id)) {
        fail(file, `duplicate mechanism id "${record.id}" (also in ${rel(rosterIds.get(record.id)!)})`);
      } else {
        rosterIds.set(record.id, file);
        if (typeof record.parent === "string") parentById.set(record.id, record.parent);
      }
    }

    if (schemaOk && hardRulesOk) {
      fullRecords.push({ file, record });
      console.log(`  ✓ ${rel(file)} valid (full record, ${impls.length} implementations)`);
    }
  }

  // 4. Seed stubs.
  const seedFiles = listJsonFiles(PATHS.seedDir);
  for (const file of seedFiles) {
    const data = readJson(file);
    if (data === undefined) continue;
    const stub = data as MechanismLike;
    const ok = validateAgainst(validateSeed, file, data);

    if (typeof stub.id === "string") {
      const expected = `${stub.id}.json`;
      if (!file.endsWith(`/${expected}`)) {
        fail(file, `filename does not match stub id "${stub.id}" (expected ${expected})`);
      }
      if (rosterIds.has(stub.id)) {
        fail(file, `duplicate mechanism id "${stub.id}" (also in ${rel(rosterIds.get(stub.id)!)})`);
      } else {
        rosterIds.set(stub.id, file);
        if (typeof stub.parent === "string") parentById.set(stub.id, stub.parent);
      }
    }
    if (typeof stub.parent === "string" && taxonomyIds.size === 7 && !taxonomyIds.has(stub.parent)) {
      fail(file, `parent "${stub.parent}" is not an L0 taxonomy node`);
    }

    if (ok) console.log(`  ✓ ${rel(file)} valid (seed stub)`);
  }

  // 5. Cross-references for full records (need the complete roster first).
  for (const { file, record } of fullRecords) {
    if (typeof record.parent === "string" && taxonomyIds.size === 7 && !taxonomyIds.has(record.parent)) {
      fail(file, `parent "${record.parent}" is not an L0 taxonomy node`);
    }
    for (const relation of record.relations ?? []) {
      if (typeof relation.target === "string" && !rosterIds.has(relation.target)) {
        fail(file, `relations target "${relation.target}" is not in the mechanism roster`);
      }
    }
  }

  // 6. Sources registry.
  const sources = readJson(PATHS.sources);
  const sourceIds = new Set<string>();
  const reportSourceIds = new Set<string>();
  if (sources !== undefined && validateAgainst(ajv.compile(sourcesSchema), PATHS.sources, sources)) {
    const classes = (sources as { classes: { sources: { id: string; connection_mode: string }[] }[] }).classes;
    for (const cls of classes)
      for (const source of cls.sources) {
        sourceIds.add(source.id);
        if (source.connection_mode === "report") reportSourceIds.add(source.id);
      }
    const count = classes.reduce((n, c) => n + c.sources.length, 0);
    console.log(`  ✓ ${rel(PATHS.sources)} valid (${count} sources)`);
  }

  // 7. Decision log.
  const decisions = readJson(PATHS.decisions);
  if (decisions !== undefined && validateAgainst(ajv.compile(decisionsSchema), PATHS.decisions, decisions)) {
    const items = (decisions as { decisions: { id: string }[] }).decisions;
    const ids = new Set(items.map((d) => d.id));
    if (ids.size !== items.length) {
      fail(PATHS.decisions, "duplicate decision ids");
    } else {
      console.log(`  ✓ ${rel(PATHS.decisions)} valid (${items.length} decisions)`);
    }
  }

  // 8. Dossier schema integrity + any dossier records.
  const dossierSchema = readJson(PATHS.dossierSchema);
  if (dossierSchema !== undefined) {
    let validateDossier: ValidateFunction | undefined;
    try {
      validateDossier = ajv.compile(dossierSchema as object);
      console.log(`  ✓ ${rel(PATHS.dossierSchema)} compiles`);
    } catch (err) {
      fail(PATHS.dossierSchema, `schema does not compile — ${(err as Error).message}`);
    }
    if (validateDossier) {
      const dossierFiles = listJsonFiles(PATHS.dossiersDir).filter(
        (f) => !f.endsWith("dossier.schema.json"),
      );
      for (const file of dossierFiles) {
        const data = readJson(file);
        if (data === undefined) continue;
        let ok = validateAgainst(validateDossier, file, data);
        const dossier = data as {
          scores?: Record<string, { score?: number }>;
          total?: number;
          mechanism_id?: string;
        };
        if (dossier.scores && typeof dossier.total === "number") {
          const sum = Object.values(dossier.scores).reduce(
            (a, axis) => a + (axis?.score ?? 0),
            0,
          );
          if (sum !== dossier.total) {
            fail(file, `total (${dossier.total}) does not equal the sum of axis scores (${sum})`);
          }
        }
        if (typeof dossier.mechanism_id === "string" && !rosterIds.has(dossier.mechanism_id)) {
          fail(file, `mechanism_id "${dossier.mechanism_id}" is not in the mechanism roster`);
        }
        // D-019: a dossier must rest on a corpus that can disconfirm — the
        // referenced mechanism's evidence file must exist, be classified,
        // and have a non-empty dissent category.
        if (typeof dossier.mechanism_id === "string" && rosterIds.has(dossier.mechanism_id)) {
          if (!checkDossierDissent(file, dossier.mechanism_id)) ok = false;
        }
        if (ok) console.log(`  ✓ ${rel(file)} valid (dossier record)`);
      }
      if (dossierFiles.length === 0) {
        console.log("  · no dossier records yet (honest empty state)");
      }
    }
  }

  // 9. Corpus manifests (connector manifest contract, tools/connectors/types.ts).
  // Every top-level corpus dir must carry a manifest, and EVERY manifest.json
  // under /corpora — at any depth — is validated against the schema (D-020),
  // so a manifest the status computation might read can never enter the repo
  // malformed.
  const validateManifest = ajv.compile(corpusManifestSchema);
  const corpusDirs = existsSync(PATHS.corporaDir)
    ? readdirSync(PATHS.corporaDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const dirName of corpusDirs) {
    // /corpora/_health (heartbeat, D-021) and /corpora/_ops (ops config,
    // D-024) are operational surfaces, not harvested corpora.
    if (NON_CORPUS_DIRS.has(dirName)) continue;
    if (!existsSync(join(PATHS.corporaDir, dirName, "manifest.json"))) {
      fail(
        join(PATHS.corporaDir, dirName),
        "corpus directory has no manifest.json (contract in corpora/README.md)",
      );
    }
  }
  const manifestFiles = findManifestFiles(PATHS.corporaDir);
  for (const manifestFile of manifestFiles) {
    const corpusDir = dirname(manifestFile);
    const dirName = basename(corpusDir);
    // Internal (framework smoke-test) corpora live under "_"-prefixed dirs
    // at any level; the app ignores them (lib/status.ts).
    const isInternal = relative(PATHS.corporaDir, corpusDir)
      .split(sep)
      .some((segment) => segment.startsWith("_"));
    const data = readJson(manifestFile);
    if (data === undefined) continue;
    let ok = validateAgainst(validateManifest, manifestFile, data);
    const manifest = data as {
      source_id?: string;
      source_ids?: string[];
      data_files?: { path: string }[];
    };
    if (typeof manifest.source_id === "string" && manifest.source_id !== dirName) {
      fail(manifestFile, `source_id "${manifest.source_id}" does not match directory name "${dirName}"`);
      ok = false;
    }
    // D-014: a connector is not a source — the manifest declares the sources
    // it harvests in source_ids; every entry must exist in sources.json, and
    // a non-internal corpus must harvest at least one source.
    if (!isInternal && (manifest.source_ids ?? []).length === 0) {
      fail(manifestFile, `non-internal corpus "${dirName}" has empty source_ids — a corpus must harvest at least one source (D-014)`);
      ok = false;
    }
    if (sourceIds.size > 0) {
      for (const id of manifest.source_ids ?? []) {
        if (!sourceIds.has(id)) {
          fail(manifestFile, `source_ids entry "${id}" is not a source id in sources.json`);
          ok = false;
        }
      }
    }
    for (const file of manifest.data_files ?? []) {
      if (!existsSync(join(corpusDir, file.path))) {
        fail(manifestFile, `data_files entry "${file.path}" does not exist on disk`);
        ok = false;
      }
    }
    if (ok) console.log(`  ✓ ${rel(manifestFile)} valid (corpus manifest)`);
  }
  if (manifestFiles.length === 0) {
    console.log("  · no harvested corpora yet (honest empty state)");
  }

  // 9b. Benchmark files (D-029): every /corpora/benchmarks/{source_id}.json
  // is owner-prepared data normalized by tools/ingest-report.ts. Beyond the
  // manifest contract above, the RECORD shape is validated here, and the
  // filename stem must be a report-mode source in sources.json — a benchmark
  // baseline for a phantom or non-report source is meaningless.
  const validateBenchmark = ajv.compile(benchmarkFileSchema);
  const benchmarkFiles = listJsonFiles(PATHS.benchmarksDir).filter(
    (f) => basename(f) !== "manifest.json",
  );
  for (const file of benchmarkFiles) {
    const data = readJson(file);
    if (data === undefined) continue;
    let ok = validateAgainst(validateBenchmark, file, data);
    const benchmark = data as { source_id?: string };
    const stem = basename(file, ".json");
    if (typeof benchmark.source_id === "string" && benchmark.source_id !== stem) {
      fail(file, `source_id "${benchmark.source_id}" does not match filename "${stem}"`);
      ok = false;
    }
    if (reportSourceIds.size > 0 && !reportSourceIds.has(stem)) {
      fail(
        file,
        sourceIds.has(stem)
          ? `"${stem}" is not a report-mode source in sources.json — ingest-report only ingests connection_mode "report" (D-013)`
          : `"${stem}" is not a source in sources.json`,
      );
      ok = false;
    }
    if (ok) console.log(`  ✓ ${rel(file)} valid (benchmark file, ${(data as BenchmarkFile).metrics.length} metrics)`);
  }

  // 9c. Evidence diversity reports (D-058): every corpora/evidence/*.json that
  // carries a diversity_report must carry a well-formed one (viewpoint + source
  // spread and a novelty block with a boolean low_novelty). Regression side
  // files (*.regression.json) carry one too and are checked the same way. A
  // corpus harvested before D-058 has no report and is skipped — the block is
  // additive, not a new hard requirement on old data.
  const validateDiversity = ajv.compile(diversityReportSchema);
  const evidenceDir = join(PATHS.corporaDir, "evidence");
  const evidenceFiles = listJsonFiles(evidenceDir).filter(
    (f) => basename(f) !== "manifest.json",
  );
  for (const file of evidenceFiles) {
    const data = readJson(file);
    if (data === undefined) continue;
    const corpus = data as EvidenceCorpusFile;
    const recordIds = new Set<string>();
    for (const record of corpus.records ?? []) {
      if (!CORPUS_RECORD_ID_PATTERN.test(record.record_id ?? "")) {
        fail(file, `record "${record.title}" has no valid stable record_id`);
        continue;
      }
      if (recordIds.has(record.record_id)) {
        fail(file, `duplicate record_id "${record.record_id}"`);
      }
      recordIds.add(record.record_id);
      const expectedId = deriveCorpusRecordId(record);
      if (record.record_id !== expectedId) {
        fail(
          file,
          `record_id "${record.record_id}" does not match deterministic id "${expectedId}"`,
        );
      }
    }
    const report = (data as { diversity_report?: unknown }).diversity_report;
    if (report !== undefined && validateAgainst(validateDiversity, file, report)) {
      console.log(`  ✓ ${rel(file)} valid (diversity report, D-058)`);
    }
  }

  // 10. Source health heartbeat (D-021), when present. Every entry's
  // source_id must exist in sources.json — health of a phantom source is
  // meaningless.
  if (existsSync(PATHS.heartbeat)) {
    const heartbeat = readJson(PATHS.heartbeat);
    if (heartbeat !== undefined) {
      let ok = validateAgainst(ajv.compile(heartbeatSchema), PATHS.heartbeat, heartbeat);
      if (sourceIds.size > 0) {
        for (const entry of (heartbeat as HeartbeatFile).entries ?? []) {
          if (typeof entry.source_id === "string" && !sourceIds.has(entry.source_id)) {
            fail(PATHS.heartbeat, `entry source_id "${entry.source_id}" is not a source id in sources.json`);
            ok = false;
          }
        }
      }
      if (ok) {
        const count = (heartbeat as HeartbeatFile).entries?.length ?? 0;
        console.log(`  ✓ ${rel(PATHS.heartbeat)} valid (${count} health entries)`);
      }
    }
  } else {
    console.log("  · no health heartbeat yet (run npm run health)");
  }

  // 11. Ops config (/corpora/_ops, D-024): validated with the SAME
  // validators the write path uses (lib/ops.ts), so the UI can never push a
  // config that would redden CI — malformed ops config fails the build
  // rather than silently misconfiguring the fleet.

  // Drift guard: the connector-id list lib/ops.ts declares (lib/ never
  // imports tools/, D-020) must equal the connector registry keys.
  const registryIds = Object.keys(CONNECTORS).sort();
  const knownIds = [...KNOWN_CONNECTOR_IDS].sort();
  if (registryIds.join(",") !== knownIds.join(",")) {
    fail(
      join(ROOT, "lib", "ops.ts"),
      `KNOWN_CONNECTOR_IDS [${knownIds.join(", ")}] does not equal the connector registry [${registryIds.join(", ")}] — update lib/ops.ts when adding a connector`,
    );
  }

  if (existsSync(OPS_PATHS.budget)) {
    const budget = readJson(OPS_PATHS.budget);
    if (budget !== undefined) {
      const errors = validateOpsBudget(budget);
      for (const message of errors) fail(OPS_PATHS.budget, message);
      if (errors.length === 0) {
        console.log(`  ✓ ${rel(OPS_PATHS.budget)} valid (ops budget)`);
      }
    }
  } else {
    console.log("  · no ops budget yet (defaults apply)");
  }

  if (existsSync(OPS_PATHS.extraction)) {
    const extraction = readJson(OPS_PATHS.extraction);
    if (extraction !== undefined) {
      const errors = validateExtractionOpsConfig(extraction);
      for (const message of errors) fail(OPS_PATHS.extraction, message);
      if (errors.length === 0) {
        console.log(`  ✓ ${rel(OPS_PATHS.extraction)} valid (extraction ops config)`);
      }
    }
  } else {
    fail(OPS_PATHS.extraction, "missing extraction ops config");
  }

  const opsFiles = listJsonFiles(OPS_PATHS.connectorsDir);
  for (const file of opsFiles) {
    const data = readJson(file);
    if (data === undefined) continue;
    const errors = validateOpsConnectorConfig(data, {
      expectedId: basename(file, ".json"),
      knownConnectorIds: registryIds,
      knownMechanismIds: Array.from(rosterIds.keys()),
    });
    for (const message of errors) fail(file, message);
    if (errors.length === 0) {
      console.log(`  ✓ ${rel(file)} valid (ops connector config)`);
    }
  }
  if (opsFiles.length === 0) {
    console.log("  · no ops connector configs yet (defaults apply)");
  }

  // 12. Product segments (D-047): /segments/segments.yaml is the
  // product-segment axis — first-class evolving data. Parse the YAML, validate
  // every entry against the schema, and enforce unique ids. The success line
  // reports the count so the pass stays honest as the list evolves.
  const segmentIds = new Set<string>();
  if (existsSync(PATHS.segments)) {
    let segmentsDoc: unknown;
    try {
      segmentsDoc = parseYaml(readFileSync(PATHS.segments, "utf-8"));
    } catch (err) {
      fail(PATHS.segments, `not valid YAML — ${(err as Error).message}`);
      segmentsDoc = undefined;
    }
    if (segmentsDoc !== undefined) {
      if (validateAgainst(ajv.compile(segmentsSchema), PATHS.segments, segmentsDoc)) {
        const items = (segmentsDoc as { segments: { id: string }[] }).segments;
        const ids = new Set(items.map((s) => s.id));
        for (const id of Array.from(ids)) segmentIds.add(id);
        if (ids.size !== items.length) {
          fail(PATHS.segments, "duplicate segment ids");
        } else {
          console.log(`  ✓ ${rel(PATHS.segments)} valid (${items.length} segments)`);
        }
      }
    }
  } else {
    console.log("  · no segments file yet (segments/segments.yaml)");
  }

  // 12b. Segment candidates (D-054): /segments/candidates.json is the
  // owner-approval queue for analyzer-proposed segments. Validate the schema,
  // enforce unique candidate ids, and reject any candidate whose id already
  // names an existing segment — a candidate is a PROPOSAL for a segment that
  // does not exist yet, so a collision means it was already promoted (or is a
  // typo). Only checked when the file is present.
  if (existsSync(PATHS.segmentCandidates)) {
    const candidatesDoc = readJson(PATHS.segmentCandidates);
    if (candidatesDoc !== undefined) {
      if (
        validateAgainst(
          ajv.compile(segmentCandidatesSchema),
          PATHS.segmentCandidates,
          candidatesDoc,
        )
      ) {
        const items = (candidatesDoc as { candidates: { id: string }[] }).candidates;
        const ids = new Set(items.map((c) => c.id));
        let ok = true;
        if (ids.size !== items.length) {
          fail(PATHS.segmentCandidates, "duplicate candidate ids");
          ok = false;
        }
        for (const id of Array.from(ids)) {
          if (segmentIds.has(id)) {
            fail(
              PATHS.segmentCandidates,
              `candidate "${id}" already names an active/retired segment — a candidate proposes a NEW segment`,
            );
            ok = false;
          }
        }
        if (ok) {
          console.log(
            `  ✓ ${rel(PATHS.segmentCandidates)} valid (${items.length} segment candidate${items.length === 1 ? "" : "s"})`,
          );
        }
      }
    }
  } else {
    console.log("  · no segment candidates yet (segments/candidates.json)");
  }

  // 13. Pack map (D-048): /packs/pack-map.yaml is the sole hand-authored input
  // to pack generation — element type → relevant mechanisms. Parse the YAML,
  // validate every element against the schema, enforce unique element ids, and
  // cross-check that EVERY referenced mechanism id resolves to a registry
  // record (rosterIds, built in passes 3–4). A pack map pointing at a phantom
  // mechanism would silently produce an empty/wrong pack.
  if (existsSync(PATHS.packMap)) {
    let packMapDoc: unknown;
    try {
      packMapDoc = parseYaml(readFileSync(PATHS.packMap, "utf-8"));
    } catch (err) {
      fail(PATHS.packMap, `not valid YAML — ${(err as Error).message}`);
      packMapDoc = undefined;
    }
    if (packMapDoc !== undefined) {
      let ok = validateAgainst(ajv.compile(packMapSchema), PATHS.packMap, packMapDoc);
      if (ok) {
        const elements = (packMapDoc as { elements: PackMapElement[] }).elements;
        const ids = new Set(elements.map((e) => e.id));
        if (ids.size !== elements.length) {
          fail(PATHS.packMap, "duplicate element ids");
          ok = false;
        }
        // The "perception" id is reserved for the cross-cutting matrix row group
        // (Step 6, D-067): the analyzer scores S7 once per segment under that
        // row, so a pack claiming it would collide with the perception cells.
        if (ids.has("perception")) {
          fail(
            PATHS.packMap,
            'element id "perception" is reserved for the cross-cutting matrix row group (D-067) — rename the pack',
          );
          ok = false;
        }
        for (const element of elements) {
          for (const mechanismId of element.mechanisms) {
            if (!rosterIds.has(mechanismId)) {
              fail(
                PATHS.packMap,
                `element "${element.id}" references mechanism "${mechanismId}" which is not in the registry roster`,
              );
              ok = false;
            }
            // The pack map stays motivational-only (D-066): cross-cutting
            // mechanisms (S7 perception) are emitted into every pack
            // automatically by render-packs, never listed per element. Listing
            // one would duplicate it in LAYER 1.
            const parent = parentById.get(mechanismId);
            if (parent !== undefined && crossCuttingL0.has(parent)) {
              fail(
                PATHS.packMap,
                `element "${element.id}" lists cross-cutting mechanism "${mechanismId}" (parent ${parent}) — cross-cutting mechanisms are emitted into every pack automatically and must not appear in the pack map (D-066)`,
              );
              ok = false;
            }
          }
        }
        if (ok) {
          console.log(`  ✓ ${rel(PATHS.packMap)} valid (${elements.length} pack-map elements)`);
        }
      }
    }
  } else {
    console.log("  · no pack map yet (packs/pack-map.yaml)");
  }

  // 13b. Pack export bundle (D-068): /packs/export/packs-bundle.yaml is the
  // committed export artifact — a multi-document YAML stream (manifest + every
  // pack datasheet verbatim) regenerated by every `npm run packs` run. When it
  // exists: it must parse, the first document must be the manifest, and the
  // manifest's pack list must exactly match the pack-*.yaml files on disk — a
  // mismatch means a stale or hand-edited bundle. Absent bundle is fine (the
  // honest state before the first render).
  if (existsSync(PATHS.packBundle)) {
    const docs = parseAllDocuments(readFileSync(PATHS.packBundle, "utf-8"));
    const parseErrors = docs.flatMap((doc) => doc.errors);
    if (parseErrors.length > 0) {
      fail(PATHS.packBundle, `not valid multi-document YAML — ${parseErrors[0].message}`);
    } else {
      const manifest = docs[0]?.toJS() as
        | { bundle?: unknown; pack_count?: unknown; packs?: unknown }
        | undefined;
      const packsOnDisk = readdirSync(PATHS.packsDir)
        .filter((entry) => entry.startsWith("pack-") && entry.endsWith(".yaml"))
        .filter((entry) => entry !== "pack-map.yaml")
        .map((entry) => entry.slice("pack-".length, -".yaml".length))
        .sort();
      let ok = true;
      if (!manifest || manifest.bundle !== "pack-export") {
        fail(PATHS.packBundle, 'first document is not the manifest (bundle: "pack-export")');
        ok = false;
      } else {
        const listed = Array.isArray(manifest.packs)
          ? (manifest.packs as unknown[]).filter((p): p is string => typeof p === "string")
          : [];
        if (
          listed.length !== packsOnDisk.length ||
          listed.some((id, i) => id !== packsOnDisk[i])
        ) {
          fail(
            PATHS.packBundle,
            `manifest packs [${listed.join(", ")}] do not match the pack files on disk [${packsOnDisk.join(", ")}] — stale or hand-edited bundle; regenerate with \`npm run packs\``,
          );
          ok = false;
        }
        if (manifest.pack_count !== packsOnDisk.length) {
          fail(
            PATHS.packBundle,
            `manifest pack_count ${String(manifest.pack_count)} does not match ${packsOnDisk.length} pack files on disk`,
          );
          ok = false;
        }
        if (docs.length !== packsOnDisk.length + 1) {
          fail(
            PATHS.packBundle,
            `bundle carries ${docs.length} YAML documents — expected ${packsOnDisk.length + 1} (manifest + one per pack)`,
          );
          ok = false;
        }
      }
      if (ok) {
        console.log(
          `  ✓ ${rel(PATHS.packBundle)} valid (manifest + ${packsOnDisk.length} pack datasheets)`,
        );
      }
    }
  } else {
    console.log("  · no pack export bundle yet (packs/export/packs-bundle.yaml)");
  }

  // 14. Interaction records (D-057): /interactions/{A}__{B}.json are
  // owner-authored pairwise interactions — the primary structural filler for
  // interaction_coverage. Compile the schema file (mechanism/dossier pattern),
  // validate every record, and cross-check: the pair is sorted and distinct,
  // both ids resolve to registry records (rosterIds, passes 3–4), the filename
  // equals {pair[0]}__{pair[1]}.json, and no pair is authored twice.
  if (existsSync(PATHS.interactionSchema)) {
    const interactionSchemaDoc = readJson(PATHS.interactionSchema);
    if (interactionSchemaDoc !== undefined) {
      let validateInteraction: ValidateFunction | undefined;
      try {
        validateInteraction = ajv.compile(interactionSchemaDoc as object);
        console.log(`  ✓ ${rel(PATHS.interactionSchema)} compiles`);
      } catch (err) {
        fail(PATHS.interactionSchema, `schema does not compile — ${(err as Error).message}`);
      }
      if (validateInteraction) {
        const interactionFiles = listJsonFiles(PATHS.interactionsDir).filter(
          (f) => basename(f) !== "interaction.schema.json",
        );
        const seenPairs = new Map<string, string>();
        for (const file of interactionFiles) {
          const data = readJson(file);
          if (data === undefined) continue;
          let ok = validateAgainst(validateInteraction, file, data);
          const record = data as { pair?: unknown };
          const pair = record.pair;
          if (
            Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string"
          ) {
            const [a, b] = pair as [string, string];
            if (a === b) {
              fail(file, `pair is a self-pair "${a}" — an interaction connects two DISTINCT mechanisms`);
              ok = false;
            } else if (a.localeCompare(b) > 0) {
              fail(file, `pair [${a}, ${b}] is not sorted — order the ids by localeCompare (expected [${b}, ${a}])`);
              ok = false;
            }
            for (const id of [a, b]) {
              if (!rosterIds.has(id)) {
                fail(file, `pair id "${id}" is not in the mechanism roster`);
                ok = false;
              }
            }
            const expected = `${a}__${b}.json`;
            if (basename(file) !== expected) {
              fail(file, `filename does not match pair (expected ${expected})`);
              ok = false;
            }
            const key = a.localeCompare(b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
            if (seenPairs.has(key)) {
              fail(file, `duplicate interaction for pair ${a}×${b} (also in ${rel(seenPairs.get(key)!)})`);
              ok = false;
            } else {
              seenPairs.set(key, file);
            }
          }
          if (ok) console.log(`  ✓ ${rel(file)} valid (interaction record)`);
        }
        if (interactionFiles.length === 0) {
          console.log("  · no interaction records yet (honest empty state)");
        }
      }
    }
  } else {
    console.log("  · no interaction schema yet (interactions/interaction.schema.json)");
  }

  // 15. First-class effects (D-076): validate the actual schema and every
  // effects/{mechanism}/{effect}.json record, then enforce both sides of the
  // mechanism/effect/realization references.
  const effectsByKey = new Map<string, { file: string; realizationIds: string[] }>();
  const fullRecordById = new Map(
    fullRecords.flatMap(({ record }) =>
      typeof record.id === "string" ? [[record.id, record] as const] : [],
    ),
  );
  if (existsSync(PATHS.effectSchema)) {
    const effectSchemaDoc = readJson(PATHS.effectSchema);
    if (effectSchemaDoc !== undefined) {
      let validateEffect: ValidateFunction | undefined;
      try {
        validateEffect = ajv.compile(effectSchemaDoc as object);
        console.log(`  ✓ ${rel(PATHS.effectSchema)} compiles`);
      } catch (err) {
        fail(PATHS.effectSchema, `schema does not compile — ${(err as Error).message}`);
      }
      if (validateEffect) {
        const effectFiles = listJsonFilesRecursive(PATHS.effectsDir).filter(
          (file) => file !== PATHS.effectSchema,
        );
        for (const file of effectFiles) {
          const data = readJson(file);
          if (data === undefined) continue;
          let ok = validateAgainst(validateEffect, file, data);
          const effect = data as {
            id?: string;
            mechanism_id?: string;
            realization_ids?: string[];
            source?: string[];
            provenance?: { doi?: string | null }[];
          };
          const parts = relative(PATHS.effectsDir, file).split(sep);
          const expected =
            typeof effect.mechanism_id === "string" && typeof effect.id === "string"
              ? [effect.mechanism_id, `${effect.id}.json`]
              : [];
          if (parts.length !== 2 || parts[0] !== expected[0] || parts[1] !== expected[1]) {
            fail(file, `path must match effects/{mechanism_id}/{id}.json`);
            ok = false;
          }
          if (
            typeof effect.mechanism_id === "string" &&
            !fullRecordById.has(effect.mechanism_id)
          ) {
            fail(file, `mechanism_id "${effect.mechanism_id}" is not a full mechanism record`);
            ok = false;
          }
          const provenanceDois = new Set(
            (effect.provenance ?? []).flatMap((item) =>
              typeof item.doi === "string" ? [item.doi] : [],
            ),
          );
          for (const doi of effect.source ?? []) {
            if (!provenanceDois.has(doi)) {
              fail(file, `source DOI "${doi}" is absent from effect provenance`);
              ok = false;
            }
          }
          if (typeof effect.mechanism_id === "string" && typeof effect.id === "string") {
            const key = `${effect.mechanism_id}\u0000${effect.id}`;
            if (effectsByKey.has(key)) {
              fail(file, `duplicate effect ${effect.mechanism_id}/${effect.id}`);
              ok = false;
            } else {
              effectsByKey.set(key, {
                file,
                realizationIds: effect.realization_ids ?? [],
              });
            }
          }
          if (ok) console.log(`  ✓ ${rel(file)} valid (effect record)`);
        }
        if (effectFiles.length === 0) {
          console.log("  · no effect records yet (honest empty state)");
        }
      }
    }
  } else {
    console.log("  · no effect schema yet (effects/effect.schema.json)");
  }

  const realizationsByKey = new Map<
    string,
    { file: string; effectId?: string }
  >();
  if (existsSync(PATHS.realizationSchema)) {
    const realizationSchemaDoc = readJson(PATHS.realizationSchema);
    if (realizationSchemaDoc !== undefined) {
      let validateRealization: ValidateFunction | undefined;
      try {
        validateRealization = ajv.compile(realizationSchemaDoc as object);
        console.log(`  ✓ ${rel(PATHS.realizationSchema)} compiles`);
      } catch (err) {
        fail(PATHS.realizationSchema, `schema does not compile — ${(err as Error).message}`);
      }
      if (validateRealization) {
        const realizationFiles = listJsonFilesRecursive(PATHS.realizationsDir).filter(
          (file) => file !== PATHS.realizationSchema,
        );
        for (const file of realizationFiles) {
          const data = readJson(file);
          if (data === undefined) continue;
          let ok = validateAgainst(validateRealization, file, data);
          const realization = data as {
            id?: string;
            mechanism_id?: string;
            effect_id?: string;
          };
          const parts = relative(PATHS.realizationsDir, file).split(sep);
          const expected =
            typeof realization.mechanism_id === "string" &&
            typeof realization.id === "string"
              ? [realization.mechanism_id, `${realization.id}.json`]
              : [];
          if (parts.length !== 2 || parts[0] !== expected[0] || parts[1] !== expected[1]) {
            fail(file, "path must match realizations/{mechanism_id}/{id}.json");
            ok = false;
          }
          if (
            typeof realization.mechanism_id === "string" &&
            !fullRecordById.has(realization.mechanism_id)
          ) {
            fail(file, `mechanism_id "${realization.mechanism_id}" is not a full mechanism record`);
            ok = false;
          }
          if (
            typeof realization.mechanism_id === "string" &&
            typeof realization.id === "string"
          ) {
            const key = `${realization.mechanism_id}\u0000${realization.id}`;
            if (realizationsByKey.has(key)) {
              fail(file, `duplicate realization ${realization.mechanism_id}/${realization.id}`);
              ok = false;
            } else {
              realizationsByKey.set(key, {
                file,
                ...(typeof realization.effect_id === "string"
                  ? { effectId: realization.effect_id }
                  : {}),
              });
            }
          }
          if (ok) console.log(`  ✓ ${rel(file)} valid (realization record)`);
        }
        if (realizationFiles.length === 0) {
          console.log("  · no realization records yet (honest empty state)");
        }
      }
    }
  } else {
    fail(PATHS.realizationSchema, "missing realization schema");
  }

  for (const [key, effect] of Array.from(effectsByKey.entries())) {
    const [mechanismId, effectId] = key.split("\u0000");
    const mechanism = fullRecordById.get(mechanismId);
    const refs = Array.isArray(mechanism?.effect_refs)
      ? mechanism.effect_refs.filter((id): id is string => typeof id === "string")
      : [];
    if (!refs.includes(effectId)) {
      fail(
        effect.file,
        `effect is not referenced by registry/mechanisms/${mechanismId}.json effect_refs`,
      );
    }
  }

  for (const { file, record } of fullRecords) {
    const effectRefs = Array.isArray(record.effect_refs)
      ? record.effect_refs.filter((id): id is string => typeof id === "string")
      : [];
    for (const effectId of effectRefs) {
      const key = `${record.id}\u0000${effectId}`;
      const effect = effectsByKey.get(key);
      if (!effect) {
        fail(file, `effect_refs entry "${effectId}" has no effects/${record.id}/${effectId}.json`);
        continue;
      }
      for (const realizationId of effect.realizationIds) {
        const realization = realizationsByKey.get(`${record.id}\u0000${realizationId}`);
        if (!realization) {
          fail(
            effect.file,
            `realization_id "${realizationId}" has no realizations/${record.id}/${realizationId}.json`,
          );
        } else if (realization.effectId !== effectId) {
          fail(
            effect.file,
            `realization_id "${realizationId}" must link back with effect_id "${effectId}"`,
          );
        }
      }
    }
    for (const implementation of record.implementations ?? []) {
      if (
        typeof implementation.effect_id === "string" &&
        !effectRefs.includes(implementation.effect_id)
      ) {
        fail(
          file,
          `implementation "${implementation.id ?? "?"}" effect_id "${implementation.effect_id}" is not in effect_refs`,
        );
      }
      if (Array.isArray(implementation.realization_ids)) {
        for (const realizationId of implementation.realization_ids) {
          const realization = realizationsByKey.get(`${record.id}\u0000${realizationId}`);
          if (!realization) {
            fail(
              file,
              `implementation "${implementation.id ?? "?"}" references missing realization "${realizationId}"`,
            );
          } else if (
            typeof implementation.effect_id === "string" &&
            realization.effectId !== undefined &&
            realization.effectId !== implementation.effect_id
          ) {
            fail(
              file,
              `implementation "${implementation.id ?? "?"}" and realization "${realizationId}" reference different effects`,
            );
          }
        }
      }
    }
  }

  // 16. Universal proposal queue (D-076): compile proposal.schema.json only
  // after all externally referenced schemas have been registered with Ajv.
  if (existsSync(PATHS.proposalSchema)) {
    const proposalSchemaDoc = readJson(PATHS.proposalSchema);
    if (proposalSchemaDoc !== undefined) {
      let validateProposal: ValidateFunction | undefined;
      try {
        validateProposal = ajv.compile(proposalSchemaDoc as object);
        console.log(`  ✓ ${rel(PATHS.proposalSchema)} compiles`);
      } catch (err) {
        fail(PATHS.proposalSchema, `schema does not compile — ${(err as Error).message}`);
      }
      if (validateProposal) {
        const proposalFiles = listJsonFilesRecursive(PATHS.proposalsDir).filter(
          (file) => file !== PATHS.proposalSchema,
        );
        for (const file of proposalFiles) {
          const data = readJson(file);
          if (data === undefined) continue;
          let ok = validateAgainst(validateProposal, file, data);
          const proposal = data as {
            id?: string;
            type?: string;
            status?: string;
            decided_by?: string | null;
            decided_at?: string | null;
            decision_note?: string | null;
            provenance?: KnowledgeProvenanceItem[];
            payload?: { provenance?: unknown };
          };
          const parts = relative(PATHS.proposalsDir, file).split(sep);
          const expected =
            typeof proposal.type === "string" && typeof proposal.id === "string"
              ? [proposal.type, `${proposal.id}.json`]
              : [];
          if (parts.length !== 2 || parts[0] !== expected[0] || parts[1] !== expected[1]) {
            fail(file, "path must match proposals/{type}/{id}.json");
            ok = false;
          }
          if (
            (proposal.status === "pending" || proposal.status === "edited") &&
            (proposal.decided_by !== null ||
              proposal.decided_at !== null ||
              proposal.decision_note !== null)
          ) {
            fail(file, `${proposal.status} proposal must not carry decision metadata`);
            ok = false;
          }
          if (
            (proposal.status === "approved" || proposal.status === "rejected") &&
            (typeof proposal.decided_by !== "string" ||
              typeof proposal.decided_at !== "string")
          ) {
            fail(file, `${proposal.status} proposal must carry decided_by and decided_at`);
            ok = false;
          }
          if (
            proposal.status === "rejected" &&
            (typeof proposal.decision_note !== "string" ||
              proposal.decision_note.trim().length === 0)
          ) {
            fail(file, "rejected proposal must carry a non-empty decision_note");
            ok = false;
          }
          if (
            proposal.type === "effect" &&
            JSON.stringify(proposal.payload?.provenance) !==
              JSON.stringify(proposal.provenance)
          ) {
            fail(file, "effect payload provenance must exactly match envelope provenance");
            ok = false;
          }
          for (const source of proposal.provenance ?? []) {
            const corpusPath = join(
              PATHS.corporaDir,
              "evidence",
              `${source.mechanism_id}.json`,
            );
            if (!existsSync(corpusPath)) {
              fail(file, `provenance corpus does not exist: ${source.mechanism_id}`);
              ok = false;
              continue;
            }
            const corpus = readJson(corpusPath) as EvidenceCorpusFile | undefined;
            const record = corpus?.records.find(
              (item) => item.record_id === source.corpus_record_id,
            );
            if (!record) {
              fail(
                file,
                `provenance record ${source.corpus_record_id} is absent from ${source.mechanism_id}`,
              );
              ok = false;
            } else if (record.title !== source.title || record.doi !== source.doi) {
              fail(
                file,
                `provenance metadata does not match record ${source.corpus_record_id}`,
              );
              ok = false;
            }
          }
          if (ok) console.log(`  ✓ ${rel(file)} valid (${proposal.status} proposal)`);
        }
        if (proposalFiles.length === 0) {
          console.log("  · no proposals yet (honest empty state)");
        }
      }
    }
  } else {
    console.log("  · no proposal schema yet (proposals/proposal.schema.json)");
  }

  finish();
}

function finish(): void {
  console.log("");
  if (errorCount > 0) {
    console.error(`FAILED — ${errorCount} violation${errorCount === 1 ? "" : "s"}. Invalid knowledge does not enter the repo.`);
    process.exit(1);
  }
  console.log("OK — all data files valid.");
}

main();
