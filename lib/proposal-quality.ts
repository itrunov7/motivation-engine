import type {
  EvidenceCorpusFile,
  KnowledgeProvenanceItem,
  Proposal,
} from "./types";

export function normalizeQualityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalizeQualityText(value).split(" ").filter((token) => token.length > 1));
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of Array.from(a)) if (b.has(token)) intersection += 1;
  const union = new Set(Array.from(a).concat(Array.from(b))).size;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(a.size, b.size);
  return Math.max(jaccard, containment * 0.9);
}

function comparableText(proposal: Proposal): string {
  switch (proposal.type) {
    case "effect":
      return `${proposal.payload.name} ${proposal.payload.fact} ${proposal.payload.boundary}`;
    case "realization":
      return `${proposal.payload.term} ${proposal.payload.description_as_reported} ${proposal.payload.artifact_context.join(" ")}`;
    case "interaction":
      return `${proposal.payload.pair.join(" ")} ${proposal.payload.fact} ${proposal.payload.boundary}`;
    case "dossier_section":
      return `${proposal.payload.field} ${JSON.stringify(proposal.payload.value)}`;
    default:
      return JSON.stringify(proposal.payload);
  }
}

export function proposalSimilarity(left: Proposal, right: Proposal): number {
  if (left.type !== right.type || left.target !== right.target) return 0;
  if (left.type === "effect" && right.type === "effect") {
    return Math.max(
      similarity(left.payload.name, right.payload.name),
      similarity(comparableText(left), comparableText(right)),
    );
  }
  if (left.type === "realization" && right.type === "realization") {
    return Math.max(
      similarity(left.payload.term, right.payload.term),
      similarity(comparableText(left), comparableText(right)),
    );
  }
  if (left.type === "interaction" && right.type === "interaction") {
    return left.payload.pair.join("__") === right.payload.pair.join("__") ? 1 : 0;
  }
  if (
    left.type === "dossier_section" &&
    right.type === "dossier_section" &&
    left.payload.field !== right.payload.field
  ) {
    return 0;
  }
  return similarity(comparableText(left), comparableText(right));
}

function provenanceKey(item: KnowledgeProvenanceItem): string {
  return `${item.mechanism_id}\u0000${item.corpus_record_id}\u0000${normalizeQualityText(
    item.quote_or_locus,
  )}`;
}

export function unionProvenance(
  ...groups: KnowledgeProvenanceItem[][]
): KnowledgeProvenanceItem[] {
  return Array.from(
    new Map(groups.flat().map((item) => [provenanceKey(item), item])).values(),
  ).sort(
    (left, right) =>
      left.corpus_record_id.localeCompare(right.corpus_record_id) ||
      left.quote_or_locus.localeCompare(right.quote_or_locus),
  );
}

function longer(left: string, right: string): string {
  return normalizeQualityText(right).length > normalizeQualityText(left).length
    ? right
    : left;
}

/** Merge a grounded candidate into a compatible pending/enrichment proposal. */
export function mergeProposals(base: Proposal, candidate: Proposal): Proposal {
  if (base.type !== candidate.type || base.target !== candidate.target) {
    throw new Error("Cannot merge proposals with different type or target");
  }
  const provenance = unionProvenance(base.provenance, candidate.provenance);
  const common = {
    ...base,
    operation: base.operation === "enrich" ? "enrich" : candidate.operation,
    provenance,
    confidence: Math.max(base.confidence, candidate.confidence),
  };
  switch (base.type) {
    case "effect": {
      if (candidate.type !== "effect") return base;
      return {
        ...common,
        type: "effect",
        payload: {
          ...base.payload,
          fact: longer(base.payload.fact, candidate.payload.fact),
          boundary: longer(base.payload.boundary, candidate.payload.boundary),
          source: Array.from(new Set([...base.payload.source, ...candidate.payload.source])).sort(),
          provenance,
        },
      };
    }
    case "realization": {
      if (candidate.type !== "realization") return base;
      return {
        ...common,
        type: "realization",
        payload: {
          ...base.payload,
          description_as_reported: longer(
            base.payload.description_as_reported,
            candidate.payload.description_as_reported,
          ),
          artifact_context: Array.from(
            new Set([...base.payload.artifact_context, ...candidate.payload.artifact_context]),
          ).sort(),
          provenance,
          confidence: Math.max(base.payload.confidence, candidate.payload.confidence),
        },
      };
    }
    case "interaction": {
      if (candidate.type !== "interaction") return base;
      return {
        ...common,
        type: "interaction",
        payload: {
          ...base.payload,
          fact: longer(base.payload.fact, candidate.payload.fact),
          boundary: longer(base.payload.boundary, candidate.payload.boundary),
          source: longer(base.payload.source, candidate.payload.source),
        },
      };
    }
    case "dossier_section": {
      if (
        candidate.type !== "dossier_section" ||
        base.payload.field !== "dissent" ||
        candidate.payload.field !== "dissent"
      ) {
        return base;
      }
      return {
        ...common,
        type: "dossier_section",
        payload: {
          field: "dissent",
          value: longer(base.payload.value, candidate.payload.value),
        },
      };
    }
    default:
      return base;
  }
}

export function groundingErrors(
  provenance: KnowledgeProvenanceItem[],
  corpus: EvidenceCorpusFile,
): string[] {
  const records = new Map(corpus.records.map((record) => [record.record_id, record]));
  const errors: string[] = [];
  for (const source of provenance) {
    const record = records.get(source.corpus_record_id);
    if (!record) {
      errors.push(`missing corpus record ${source.corpus_record_id}`);
      continue;
    }
    if (source.mechanism_id !== corpus.mechanism_id) {
      errors.push(`mechanism mismatch for ${source.corpus_record_id}`);
    }
    if (record.doi === null || source.doi !== record.doi) {
      errors.push(`DOI does not resolve for ${source.corpus_record_id}`);
    }
    if (source.title !== record.title) {
      errors.push(`title mismatch for ${source.corpus_record_id}`);
    }
    const locus = normalizeQualityText(source.quote_or_locus);
    const sourceText = normalizeQualityText(`${record.title}\n${record.abstract ?? ""}`);
    if (!locus || !sourceText.includes(locus)) {
      errors.push(`quote does not resolve for ${source.corpus_record_id}`);
    }
  }
  return errors;
}

export function hasNovelEnrichment(base: Proposal, merged: Proposal): boolean {
  if (JSON.stringify(base.payload) !== JSON.stringify(merged.payload)) return true;
  return unionProvenance(base.provenance).length !== unionProvenance(merged.provenance).length;
}
