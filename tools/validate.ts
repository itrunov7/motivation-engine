/**
 * tools/validate.ts — repo-wide data validation (SPEC.md §6).
 *
 * Validates:
 * - /registry/mechanisms/*.json against mechanism.schema.json (full records)
 * - /registry/mechanisms/_seed/*.json against the seedStub sub-schema
 * - HARD RULE (checked explicitly on top of the schema): a full record with
 *   empty/missing implementations[].metrics or constraints.hard_rules FAILS
 * - /registry/taxonomy.json, /sources/sources.json, /decisions/decisions.json
 * - /dossiers/dossier.schema.json integrity + any dossier records; a dossier
 *   referencing a mechanism whose evidence corpus is missing, unclassified,
 *   or has an empty dissent category FAILS (D-019)
 * - EVERY manifest.json under /corpora, at any depth, against the connector
 *   manifest contract (tools/connectors/types.ts): dir name = source_id,
 *   run_history ≤ 20, data_files exist on disk, every source_ids entry
 *   matches a source id in sources.json, non-"_" dirs harvest ≥1 source
 *   (D-014)
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
import {
  EVIDENCE_CATEGORIES,
  RUN_HISTORY_LIMIT,
  type Manifest,
  type ManifestDataFile,
  type ManifestRun,
} from "./connectors/types";
import type { CorpusManifest } from "../lib/types";

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
};

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
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^S[1-6]$" },
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
const manifestRunProperties = {
  timestamp: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["success", "partial", "failed"] },
  params: { type: "object", additionalProperties: { type: "string" } },
  records_fetched: { type: "integer", minimum: 0 },
  files_written: { type: "integer", minimum: 0 },
  duration_s: { type: "number", minimum: 0 },
  error: { type: "string", minLength: 1 },
  warnings: { type: "object", additionalProperties: { type: "boolean" } },
} as const satisfies Record<keyof ManifestRun, unknown>;

const manifestRunRequired = [
  "timestamp",
  "status",
  "params",
  "records_fetched",
  "files_written",
  "duration_s",
] as const satisfies readonly (keyof ManifestRun)[];

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

// ---------- Validation passes ----------

interface MechanismLike {
  id?: string;
  parent?: string;
  implementations?: { id?: string; metrics?: unknown }[];
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
  const taxonomy = readJson(PATHS.taxonomy) as { nodes?: { id: string }[] } | undefined;
  const taxonomyIds = new Set<string>();
  if (taxonomy !== undefined && validateAgainst(ajv.compile(taxonomySchema), PATHS.taxonomy, taxonomy)) {
    for (const node of taxonomy.nodes ?? []) taxonomyIds.add(node.id);
    if (taxonomyIds.size !== 6) {
      fail(PATHS.taxonomy, `expected 6 unique node ids S1–S6, found ${taxonomyIds.size}`);
    } else {
      console.log(`  ✓ ${rel(PATHS.taxonomy)} valid (${taxonomyIds.size} L0 nodes)`);
    }
  }

  // 3. Full mechanism records.
  const fullFiles = listJsonFiles(PATHS.mechanismsDir);
  const rosterIds = new Map<string, string>(); // id -> file
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

    if (typeof record.id === "string") {
      const expected = `${record.id}.json`;
      if (!file.endsWith(`/${expected}`)) {
        fail(file, `filename does not match record id "${record.id}" (expected ${expected})`);
      }
      if (rosterIds.has(record.id)) {
        fail(file, `duplicate mechanism id "${record.id}" (also in ${rel(rosterIds.get(record.id)!)})`);
      } else {
        rosterIds.set(record.id, file);
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
      }
    }
    if (typeof stub.parent === "string" && taxonomyIds.size === 6 && !taxonomyIds.has(stub.parent)) {
      fail(file, `parent "${stub.parent}" is not an L0 taxonomy node`);
    }

    if (ok) console.log(`  ✓ ${rel(file)} valid (seed stub)`);
  }

  // 5. Cross-references for full records (need the complete roster first).
  for (const { file, record } of fullRecords) {
    if (typeof record.parent === "string" && taxonomyIds.size === 6 && !taxonomyIds.has(record.parent)) {
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
  if (sources !== undefined && validateAgainst(ajv.compile(sourcesSchema), PATHS.sources, sources)) {
    const classes = (sources as { classes: { sources: { id: string }[] }[] }).classes;
    for (const cls of classes) for (const source of cls.sources) sourceIds.add(source.id);
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
          scores?: Record<string, number>;
          total?: number;
          mechanism_id?: string;
        };
        if (dossier.scores && typeof dossier.total === "number") {
          const sum = Object.values(dossier.scores).reduce((a, b) => a + b, 0);
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
