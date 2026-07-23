/**
 * tools/population-report.ts — per-mechanism population report (D-085).
 *
 * Usage:
 *   npm run report -- shelf=S8
 *
 * Everything is COMPUTED from repository files (rule 2 — honest statuses):
 * corpus size and saturation from corpora/evidence/{id}.json, proposals from
 * proposals/{type}/*.json, approval rate from decided proposals, record
 * completeness against mechanism.schema.json required fields, and dossier
 * completeness from dossiers/{id}.json. Output:
 *   analysis/population-report-{shelf}.json + analysis/population-report-{shelf}.md
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  Dossier,
  EvidenceCorpusFile,
  Mechanism,
  Proposal,
  RealizationCorpusFile,
  SeedStub,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const ANALYSIS_DIR = join(ROOT, "analysis");

interface TaxonomyFile {
  nodes: { id: string; name: string }[];
}

interface CorpusSummary {
  exists: boolean;
  records: number;
  records_with_abstract: number;
  fetched_at: string | null;
  saturation:
    | {
        reached: boolean;
        stop_reason: string;
        queries_issued: number;
        records_added: number;
      }
    | null;
}

interface ProposalCounts {
  by_type: Record<string, Record<string, number>>;
  pending: number;
  approved: number;
  rejected: number;
  held: number;
  decided: number;
  approval_rate: number | null;
}

interface RecordCompleteness {
  exists: boolean;
  state: "full_record" | "seed_candidate";
  missing_required_fields: string[];
  implementations: number;
  implementations_with_metrics: number;
  hard_rules: number;
  relations: number;
  complete: boolean;
}

interface DossierCompleteness {
  exists: boolean;
  axes_scored: number;
  total: number | null;
  verdict: string | null;
  has_dissent: boolean;
  evidence_sources: number;
  complete: boolean;
}

interface MechanismReport {
  id: string;
  name: string;
  corpus: CorpusSummary;
  realization_corpus_records: number;
  proposals: ProposalCounts;
  record: RecordCompleteness;
  dossier: DossierCompleteness;
}

interface PopulationReport {
  shelf: string;
  shelf_name: string;
  generated_at: string;
  mechanisms: MechanismReport[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function shelfMembers(shelf: string): { id: string; name: string; full: boolean }[] {
  const members: { id: string; name: string; full: boolean }[] = [];
  for (const file of listJson(join(ROOT, "registry", "mechanisms"))) {
    const mechanism = readJson<Mechanism>(file);
    if (mechanism.parent === shelf) {
      members.push({ id: mechanism.id, name: mechanism.name, full: true });
    }
  }
  for (const file of listJson(join(ROOT, "registry", "mechanisms", "_seed"))) {
    const stub = readJson<SeedStub>(file);
    if (stub.parent === shelf) {
      members.push({ id: stub.id, name: stub.name, full: false });
    }
  }
  return members.sort((left, right) => left.id.localeCompare(right.id));
}

function corpusSummary(mechanismId: string): CorpusSummary {
  const path = join(ROOT, "corpora", "evidence", `${mechanismId}.json`);
  if (!existsSync(path)) {
    return {
      exists: false,
      records: 0,
      records_with_abstract: 0,
      fetched_at: null,
      saturation: null,
    };
  }
  const corpus = readJson<EvidenceCorpusFile>(path);
  return {
    exists: true,
    records: corpus.records.length,
    records_with_abstract: corpus.records.filter(
      (record) => typeof record.abstract === "string" && record.abstract.trim(),
    ).length,
    fetched_at: corpus.fetched_at,
    saturation: corpus.saturation_report
      ? {
          reached: corpus.saturation_report.saturation_reached,
          stop_reason: corpus.saturation_report.stop_reason,
          queries_issued: corpus.saturation_report.queries_issued,
          records_added: corpus.saturation_report.records_added,
        }
      : null,
  };
}

function realizationCorpusRecords(mechanismId: string): number {
  const path = join(ROOT, "corpora", "realizations", mechanismId, "records.json");
  if (!existsSync(path)) return 0;
  return readJson<RealizationCorpusFile>(path).records.length;
}

function targetsMechanism(proposal: Proposal, mechanismId: string): boolean {
  if (proposal.type === "interaction") {
    return proposal.payload.pair.includes(mechanismId);
  }
  return proposal.target === mechanismId;
}

function proposalCounts(mechanismId: string, all: Proposal[]): ProposalCounts {
  const mine = all.filter((proposal) => targetsMechanism(proposal, mechanismId));
  const byType: Record<string, Record<string, number>> = {};
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let held = 0;
  for (const proposal of mine) {
    const statuses = (byType[proposal.type] ??= {});
    statuses[proposal.status] = (statuses[proposal.status] ?? 0) + 1;
    if (proposal.status === "pending" || proposal.status === "edited") pending += 1;
    if (proposal.status === "approved") approved += 1;
    if (proposal.status === "rejected") rejected += 1;
    if (proposal.status === "held_low_confidence") held += 1;
  }
  const decided = approved + rejected;
  return {
    by_type: byType,
    pending,
    approved,
    rejected,
    held,
    decided,
    approval_rate: decided > 0 ? Math.round((approved / decided) * 1000) / 1000 : null,
  };
}

function requiredMechanismFields(): string[] {
  const schema = readJson<{ required?: string[] }>(
    join(ROOT, "registry", "mechanism.schema.json"),
  );
  return schema.required ?? [];
}

function recordCompleteness(
  mechanismId: string,
  requiredFields: string[],
): RecordCompleteness {
  const path = join(ROOT, "registry", "mechanisms", `${mechanismId}.json`);
  if (!existsSync(path)) {
    return {
      exists: false,
      state: "seed_candidate",
      missing_required_fields: requiredFields,
      implementations: 0,
      implementations_with_metrics: 0,
      hard_rules: 0,
      relations: 0,
      complete: false,
    };
  }
  const mechanism = readJson<Mechanism>(path);
  const record = mechanism as unknown as Record<string, unknown>;
  const missing = requiredFields.filter((field) => record[field] === undefined);
  const implementations = mechanism.implementations ?? [];
  const withMetrics = implementations.filter(
    (item) => Array.isArray(item.metrics) && item.metrics.length > 0,
  );
  const hardRules = mechanism.constraints?.hard_rules ?? [];
  return {
    exists: true,
    state: "full_record",
    missing_required_fields: missing,
    implementations: implementations.length,
    implementations_with_metrics: withMetrics.length,
    hard_rules: hardRules.length,
    relations: mechanism.relations?.length ?? 0,
    complete:
      missing.length === 0 &&
      implementations.length > 0 &&
      withMetrics.length === implementations.length &&
      hardRules.length > 0,
  };
}

function dossierCompleteness(mechanismId: string): DossierCompleteness {
  const path = join(ROOT, "dossiers", `${mechanismId}.json`);
  if (!existsSync(path)) {
    return {
      exists: false,
      axes_scored: 0,
      total: null,
      verdict: null,
      has_dissent: false,
      evidence_sources: 0,
      complete: false,
    };
  }
  const dossier = readJson<Dossier>(path);
  const axes = Object.values(dossier.scores ?? {});
  const scored = axes.filter(
    (axis) =>
      Number.isInteger(axis.score) &&
      typeof axis.rationale === "string" &&
      axis.rationale.trim().length > 0,
  ).length;
  const hasDissent =
    typeof dossier.dissent === "string" && dossier.dissent.trim().length > 0;
  return {
    exists: true,
    axes_scored: scored,
    total: dossier.total,
    verdict: dossier.verdict,
    has_dissent: hasDissent,
    evidence_sources: dossier.evidence_sources?.length ?? 0,
    complete: scored === 5 && hasDissent && (dossier.evidence_sources?.length ?? 0) > 0,
  };
}

function loadAllProposals(): Proposal[] {
  const root = join(ROOT, "proposals");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      listJson(join(root, entry.name)).filter(
        (file) => basename(file) !== "proposal.schema.json",
      ),
    )
    .map((file) => readJson<Proposal>(file));
}

function buildReport(shelf: string, now: Date): PopulationReport {
  const taxonomy = readJson<TaxonomyFile>(join(ROOT, "registry", "taxonomy.json"));
  const node = taxonomy.nodes.find((candidate) => candidate.id === shelf);
  if (!node) throw new Error(`Unknown shelf "${shelf}" — not in registry/taxonomy.json`);
  const members = shelfMembers(shelf);
  if (members.length === 0) {
    throw new Error(`Shelf ${shelf} has no mechanisms or seed candidates`);
  }
  const proposals = loadAllProposals();
  const requiredFields = requiredMechanismFields();
  return {
    shelf,
    shelf_name: node.name,
    generated_at: now.toISOString(),
    mechanisms: members.map((member) => ({
      id: member.id,
      name: member.name,
      corpus: corpusSummary(member.id),
      realization_corpus_records: realizationCorpusRecords(member.id),
      proposals: proposalCounts(member.id, proposals),
      record: recordCompleteness(member.id, requiredFields),
      dossier: dossierCompleteness(member.id),
    })),
  };
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function markdown(report: PopulationReport): string {
  const lines: string[] = [
    `# Population report — ${report.shelf} · ${report.shelf_name}`,
    "",
    `Generated ${report.generated_at} from repository files only (rule 2). ` +
      "Empty cells are honest: they show what the pipeline has not produced yet.",
    "",
    "| Mechanism | Corpus | Saturation | Proposals (P/A/R/H) | Approval | Record | Dossier |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const m of report.mechanisms) {
    const corpus = m.corpus.exists
      ? `${m.corpus.records} records (${m.corpus.records_with_abstract} w/ abstract)` +
        (m.realization_corpus_records > 0
          ? ` + ${m.realization_corpus_records} interface`
          : "")
      : "not harvested";
    const saturation = m.corpus.saturation
      ? m.corpus.saturation.reached
        ? `reached (${m.corpus.saturation.queries_issued} queries)`
        : `stopped: ${m.corpus.saturation.stop_reason}`
      : m.corpus.exists
        ? "no saturation report"
        : "—";
    const proposals =
      m.proposals.pending + m.proposals.decided + m.proposals.held > 0
        ? `${m.proposals.pending}/${m.proposals.approved}/${m.proposals.rejected}/${m.proposals.held}`
        : "none";
    const record =
      m.record.state === "seed_candidate"
        ? "seed only"
        : m.record.complete
          ? `complete (${m.record.implementations} impl, ${m.record.hard_rules} rules)`
          : `incomplete — missing ${m.record.missing_required_fields.join(", ") || "hard-rule/metric coverage"}`;
    const dossier = m.dossier.exists
      ? `${m.dossier.axes_scored}/5 axes · total ${m.dossier.total} · ${m.dossier.verdict}` +
        (m.dossier.complete ? "" : " · INCOMPLETE")
      : "none";
    lines.push(
      `| ${m.id} · ${m.name} | ${corpus} | ${saturation} | ${proposals} | ${pct(
        m.proposals.approval_rate,
      )} | ${record} | ${dossier} |`,
    );
  }
  const byTypeLines: string[] = [];
  for (const m of report.mechanisms) {
    const entries = Object.entries(m.proposals.by_type);
    if (entries.length === 0) continue;
    byTypeLines.push(
      `- **${m.id}**: ` +
        entries
          .map(
            ([type, statuses]) =>
              `${type} (${Object.entries(statuses)
                .map(([status, count]) => `${status}: ${count}`)
                .join(", ")})`,
          )
          .join("; "),
    );
  }
  lines.push(
    "",
    "Proposals column counts pending+edited / approved / rejected / held-low-confidence.",
    "",
    "## Proposals by type",
    "",
    ...(byTypeLines.length > 0 ? byTypeLines : ["- none yet"]),
    "",
  );
  return lines.join("\n");
}

function main(): void {
  const params = new Map(
    process.argv.slice(2).map((arg) => {
      const at = arg.indexOf("=");
      if (at < 1) throw new Error(`Invalid argument "${arg}"; expected key=value`);
      return [arg.slice(0, at), arg.slice(at + 1)] as const;
    }),
  );
  const shelf = params.get("shelf");
  if (!shelf || !/^S[1-8]$/.test(shelf)) {
    throw new Error("Usage: npm run report -- shelf=S8");
  }
  const report = buildReport(shelf, new Date());
  mkdirSync(ANALYSIS_DIR, { recursive: true });
  const jsonPath = join(ANALYSIS_DIR, `population-report-${shelf}.json`);
  const mdPath = join(ANALYSIS_DIR, `population-report-${shelf}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, markdown(report));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  for (const m of report.mechanisms) {
    console.log(
      `${m.id}: corpus=${m.corpus.records} proposals=${
        m.proposals.pending + m.proposals.decided + m.proposals.held
      } approval=${pct(m.proposals.approval_rate)} record=${
        m.record.state
      } dossier=${m.dossier.exists ? "yes" : "no"}`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
