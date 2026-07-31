import { createHash } from "node:crypto";
import type {
  Effect,
  EvidenceCorpusFile,
  EvidenceProvenanceItem,
  InferenceProvenanceItem,
  KnowledgeProvenanceItem,
  Proposal,
  RealizationCorpusFile,
  RealizationCorpusProvenanceItem,
} from "./types";
import { isInferenceProvenance, isRealizationProvenance } from "./realization-corpus";

/** Hex sha256, the one hash used for source-text versions (D-110). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The exact text the grounding gate compares an evidence quote against, and the
 * string that `source_span` offsets and `source_text_sha256` are resolved
 * against (D-110).
 *
 * Defined ONCE, here, because it had two independent implementations — this
 * module inlined it and tools/extract.ts kept its own copy. Two definitions of
 * "the source text" is precisely how offsets come to index one string while the
 * gate reads another, and a byte offset into the wrong string is worse than no
 * offset at all. Anything that stores, slices, or hashes a span must obtain the
 * text from here.
 */
export function evidenceSourceText(record: {
  title: string;
  abstract: string | null;
}): string {
  return `${record.title}\n${record.abstract ?? ""}`;
}

/** The same single definition for a realization corpus record (D-110). */
export function realizationSourceText(record: {
  title: string;
  observation: string;
}): string {
  return `${record.title}\n${record.observation}`;
}

/**
 * Numbers spelled as words. A threshold smuggled in as "three times" reads as
 * measured precision exactly like "3 times" does, so both forms are caught.
 */
const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

const PLACEHOLDER = /\{([a-z0-9_]*)\}/g;
const BARE_NUMBER = new RegExp(`\\d|\\b(?:${NUMBER_WORDS.join("|")})\\b`, "i");

/**
 * Whether a realization's `pattern` states its thresholds as declared,
 * overridable parameters rather than as prose facts (D-115).
 *
 * The pipeline invented "three times" and wrote it as if a study had measured
 * it. No source did. A number the pattern depends on must therefore appear as
 * a `{name}` placeholder resolving to a declared parameter that carries its own
 * evidence_basis; a bare digit or number-word left in the prose is a
 * quantitative claim with no provenance, which is the thing this rejects.
 */
export function patternParameterErrors(
  pattern: string,
  parameters: { name: string }[],
): string[] {
  const errors: string[] = [];
  const declared = new Set(parameters.map((parameter) => parameter.name));
  const referenced = new Set<string>();
  for (const [, name] of Array.from(pattern.matchAll(PLACEHOLDER))) {
    referenced.add(name);
    if (!declared.has(name)) {
      errors.push(`pattern references {${name}}, which is not a declared parameter`);
    }
  }
  for (const parameter of parameters) {
    if (!referenced.has(parameter.name)) {
      errors.push(
        `parameter "${parameter.name}" is declared but never referenced as ` +
          `{${parameter.name}} in the pattern`,
      );
    }
  }
  const prose = pattern.replace(PLACEHOLDER, " ");
  const bare = BARE_NUMBER.exec(prose);
  if (bare) {
    errors.push(
      `pattern states the number "${bare[0]}" as prose; no source measured it — ` +
        "declare it in parameters and reference it as {name} (D-115)",
    );
  }
  return errors;
}

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
      return `${proposal.payload.term} ${proposal.payload.description_as_reported} ${
        proposal.payload.pattern ?? ""
      } ${proposal.payload.artifact_context.join(" ")}`;
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
      // derivation and domain_transfer are NOT merged: a reported record and an
      // inferred one make different claims about the same words, so the base's
      // derivation stands and a cross-derivation merge keeps the base's honesty
      // marking rather than blending the two.
      const effectRefs = Array.from(
        new Set([
          ...(base.payload.effect_refs ?? []),
          ...(candidate.payload.effect_refs ?? []),
        ]),
      ).sort();
      const pattern =
        base.payload.pattern && candidate.payload.pattern
          ? longer(base.payload.pattern, candidate.payload.pattern)
          : (base.payload.pattern ?? candidate.payload.pattern);
      return {
        ...common,
        type: "realization",
        payload: {
          ...base.payload,
          ...(effectRefs.length > 0 ? { effect_refs: effectRefs } : {}),
          // Only carried when the base is inferred; the schema forbids a pattern
          // on a reported record, and a merge must not smuggle one in.
          ...(base.payload.derivation === "inferred" && pattern ? { pattern } : {}),
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

/**
 * Named conditions a stored `source_span` can be in (D-110). Distinguished from
 * each other and from an ordinary quote failure on purpose: "the corpus text
 * changed under this span" and "this quote is not in the source" are different
 * facts with different remedies, and collapsing them into one message is what
 * made the earlier ungrounded drops unreadable (D-098).
 */
export const SPAN_CONDITIONS = [
  /** The offsets do not fit the source text — nothing can be sliced. */
  "span_out_of_range",
  /** The offsets fit, but re-slicing does not reproduce quote_or_locus. */
  "span_does_not_reslice",
  /** The source text no longer hashes to what the offsets were resolved against. */
  "span_stale",
] as const;
export type SpanCondition = (typeof SPAN_CONDITIONS)[number];

/**
 * Verify a stored span by RE-SLICING, never by trusting the emitted quote.
 *
 * The hash is checked as well as the slice because the two catch different
 * failures: a re-harvested record can still contain the quoted words at
 * different offsets (slice mismatch), and it can also contain different words at
 * the same offsets that happen to differ from the quote — but an edit elsewhere
 * in the abstract shifts every later offset while leaving this one re-slicing
 * cleanly, and only the hash sees that. A span whose text version is unknown is
 * a span pointing into a document that may no longer exist.
 *
 * Returns [] when the item carries no span: absent is legacy, not invalid. That
 * an extraction-authored item MUST carry one is enforced where authorship is
 * known — the provenance builder and tools/validate.ts — not here.
 */
export function spanErrors(
  source: EvidenceProvenanceItem,
  rawSourceText: string,
): string[] {
  const span = source.source_span;
  if (!span) return [];
  const errors: string[] = [];
  const actualHash = sha256Hex(rawSourceText);
  if (actualHash !== span.source_text_sha256) {
    errors.push(
      `span_stale for ${source.corpus_record_id}: source text now hashes to ${actualHash}, ` +
        `span was resolved against ${span.source_text_sha256}`,
    );
  }
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end <= span.start ||
    span.end > rawSourceText.length
  ) {
    errors.push(
      `span_out_of_range for ${source.corpus_record_id}: [${span.start},${span.end}) ` +
        `does not fit ${rawSourceText.length} characters`,
    );
    return errors;
  }
  const resliced = rawSourceText.slice(span.start, span.end);
  if (resliced !== source.quote_or_locus) {
    errors.push(
      `span_does_not_reslice for ${source.corpus_record_id}: [${span.start},${span.end}) ` +
        `yields ${JSON.stringify(resliced)}, quote_or_locus is ${JSON.stringify(source.quote_or_locus)}`,
    );
  }
  return errors;
}

/** True when an error string names one of the span conditions above. */
export function isSpanConditionError(error: string): boolean {
  return SPAN_CONDITIONS.some((condition) => error.startsWith(`${condition} `));
}

/**
 * Verify an inference provenance item against the effect it names (D-112).
 *
 * There is nothing to re-slice — that is the declared property of the item — so
 * what CAN be checked is checked instead: that the effect exists, that the
 * quote is the effect's own statement rather than a paraphrase of it, and that
 * the evidence record the item points at is one the effect itself cites. An
 * inference whose quote drifts from the effect it claims to transfer is a
 * broken trail even though no span was ever promised.
 *
 * `basis` is the effect record or, before approval, the payload of the pending
 * effect proposal. Resolution is the caller's job because the extractor, the
 * validator, and the approval path each read the repository differently.
 */
export function inferenceGroundingErrors(
  provenance: readonly InferenceProvenanceItem[],
  basis: Effect | null,
): string[] {
  const errors: string[] = [];
  for (const source of provenance) {
    if (!basis) {
      errors.push(`inference basis effect ${source.effect_id} does not exist`);
      continue;
    }
    if (basis.id !== source.effect_id) {
      errors.push(
        `inference basis mismatch for ${source.effect_id}: supplied effect is ${basis.id}`,
      );
      continue;
    }
    if (basis.mechanism_id !== source.mechanism_id) {
      errors.push(`mechanism mismatch for inference on ${source.effect_id}`);
    }
    const statements = [basis.fact.trim(), basis.boundary.trim()];
    if (!statements.includes(source.quote_or_locus.trim())) {
      errors.push(
        `inference quote is not the own statement of effect ${source.effect_id}`,
      );
    }
    const cited = basis.provenance.find(
      (item) => item.corpus_record_id === source.corpus_record_id,
    );
    if (!cited) {
      errors.push(
        `inference record ${source.corpus_record_id} is not cited by effect ${source.effect_id}`,
      );
      continue;
    }
    if (cited.title !== source.title) {
      errors.push(`title mismatch for ${source.corpus_record_id}`);
    }
  }
  return errors;
}

export function groundingErrors(
  provenance: KnowledgeProvenanceItem[],
  corpus: EvidenceCorpusFile,
): string[] {
  const records = new Map(corpus.records.map((record) => [record.record_id, record]));
  const errors: string[] = [];
  for (const source of provenance) {
    if (isRealizationProvenance(source)) {
      errors.push(`wrong corpus kind for ${source.corpus_record_id}`);
      continue;
    }
    if (isInferenceProvenance(source)) {
      // Fail closed rather than skip: an inference item reaching the evidence
      // gate means a caller forgot to route it to inferenceGroundingErrors, and
      // a silent pass there would look exactly like a verified quote (D-112).
      errors.push(
        `inference provenance for effect ${source.effect_id} must be checked against ` +
          "its effect, not against the evidence corpus",
      );
      continue;
    }
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
    const rawSourceText = evidenceSourceText(record);
    const locus = normalizeQualityText(source.quote_or_locus);
    const sourceText = normalizeQualityText(rawSourceText);
    if (!locus || !sourceText.includes(locus)) {
      errors.push(`quote does not resolve for ${source.corpus_record_id}`);
    }
    errors.push(...spanErrors(source, rawSourceText));
  }
  return errors;
}

export function realizationGroundingErrors(
  provenance: RealizationCorpusProvenanceItem[],
  corpus: RealizationCorpusFile,
): string[] {
  const records = new Map(corpus.records.map((record) => [record.record_id, record]));
  const errors: string[] = [];
  for (const source of provenance) {
    const record = records.get(source.corpus_record_id);
    if (!record) {
      errors.push(`missing realization corpus record ${source.corpus_record_id}`);
      continue;
    }
    if (source.mechanism_id !== corpus.mechanism_id) {
      errors.push(`mechanism mismatch for ${source.corpus_record_id}`);
    }
    if (source.source_id !== record.source_id) {
      errors.push(`source mismatch for ${source.corpus_record_id}`);
    }
    if (source.title !== record.title) {
      errors.push(`title mismatch for ${source.corpus_record_id}`);
    }
    if (source.contributed_by !== record.contributed_by) {
      errors.push(`contributor mismatch for ${source.corpus_record_id}`);
    }
    const locus = normalizeQualityText(source.quote_or_locus);
    const sourceText = normalizeQualityText(realizationSourceText(record));
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
