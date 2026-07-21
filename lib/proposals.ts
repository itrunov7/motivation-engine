import { posix } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  DecisionsLog,
  Dossier,
  Effect,
  InteractionRecord,
  Mechanism,
  Proposal,
  ProposalStatus,
  Segment,
  SegmentsFile,
} from "./types";

export const PROPOSAL_TYPES = [
  "effect",
  "realization",
  "interaction",
  "mechanism",
  "dossier_section",
  "segment",
] as const;

export interface RepositorySnapshot {
  read(path: string): Promise<string | null>;
}

export interface FileMutation {
  /** Repo-relative POSIX path. */
  path: string;
  /** UTF-8 contents, or null to delete the file. */
  content: string | null;
  /** Exact content observed while preparing the transaction. */
  expectedContent: string | null;
}

export interface ProposalDecisionRequest {
  proposalPath: string;
  action: "approve" | "reject" | "edit";
  decidedBy: string;
  decidedAt: string;
  /** Required for rejection; optional audit note for approval. */
  reason?: string;
  /** Complete replacement payload for an edit. */
  editedPayload?: unknown;
  /** Repository root containing the actual JSON schemas. Defaults to cwd. */
  schemaRoot?: string;
}

export interface PreparedProposalTransaction {
  action: ProposalDecisionRequest["action"];
  proposalId: string;
  proposalType: Proposal["type"];
  decisionId: string;
  commitMessage: string;
  mutations: FileMutation[];
}

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalValidationError";
  }
}

interface Validators {
  proposal: ValidateFunction;
  mechanism: ValidateFunction;
  effect: ValidateFunction;
  interaction: ValidateFunction;
  dossier: ValidateFunction;
}

const validatorsByRoot = new Map<string, Validators>();
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MECHANISM_ID = /^[A-Z]{2}-\d{2}$/;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

async function readSchema(root: string, path: string): Promise<object> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(posix.join(root, path), "utf8")) as object;
  } catch (error) {
    throw new ProposalValidationError(
      `Cannot load schema ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getValidators(root: string): Promise<Validators> {
  const cached = validatorsByRoot.get(root);
  if (cached) return cached;

  const [proposalSchema, mechanismSchema, effectSchema, interactionSchema, dossierSchema] =
    await Promise.all([
      readSchema(root, "proposals/proposal.schema.json"),
      readSchema(root, "registry/mechanism.schema.json"),
      readSchema(root, "effects/effect.schema.json"),
      readSchema(root, "interactions/interaction.schema.json"),
      readSchema(root, "dossiers/dossier.schema.json"),
    ]);
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(mechanismSchema);
  ajv.addSchema(effectSchema);
  ajv.addSchema(interactionSchema);
  ajv.addSchema(dossierSchema);
  const validators = {
    proposal: ajv.compile(proposalSchema),
    mechanism: ajv.getSchema(
      "https://ventora.dev/motivation-engine/mechanism.schema.json",
    )!,
    effect: ajv.getSchema("https://ventora.dev/motivation-engine/effect.schema.json")!,
    interaction: ajv.getSchema(
      "https://ventora.dev/motivation-engine/interaction.schema.json",
    )!,
    dossier: ajv.getSchema("https://ventora.dev/motivation-engine/dossier.schema.json")!,
  };
  validatorsByRoot.set(root, validators);
  return validators;
}

function assertSchema(name: string, validate: ValidateFunction, value: unknown): void {
  if (!validate(value)) {
    throw new ProposalValidationError(`${name} failed schema validation: ${validationMessage(validate.errors)}`);
  }
}

function parseJson<T>(path: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProposalValidationError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertSafePath(path: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ProposalValidationError(`Unsafe repository path: ${path}`);
  }
}

function assertSafeComponent(label: string, value: string): void {
  if (!SAFE_COMPONENT.test(value)) {
    throw new ProposalValidationError(`${label} is not a safe filename component: ${value}`);
  }
}

function assertIsoTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new ProposalValidationError(`decidedAt must be an ISO date-time: ${value}`);
  }
}

function assertPendingTransition(
  status: ProposalStatus,
  action: ProposalDecisionRequest["action"],
): void {
  if (status !== "pending" && status !== "edited") {
    throw new ProposalValidationError(
      `Cannot ${action} a proposal in terminal status "${status}"; expected pending or edited`,
    );
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function assertPayloadProvenance(proposal: Proposal): void {
  if (proposal.provenance.length === 0) {
    throw new ProposalValidationError("Proposal provenance must not be empty");
  }
  if (proposal.type === "effect") {
    if (canonical(proposal.payload.provenance) !== canonical(proposal.provenance)) {
      throw new ProposalValidationError(
        "Effect payload provenance must exactly match the proposal envelope provenance",
      );
    }
    const provenanceDois = new Set(
      proposal.provenance.flatMap((item) => (item.doi === null ? [] : [item.doi])),
    );
    for (const doi of proposal.payload.source) {
      if (!provenanceDois.has(doi)) {
        throw new ProposalValidationError(
          `Effect source DOI ${doi} is absent from proposal provenance`,
        );
      }
    }
  }
}

class MutationBuilder {
  private readonly changes = new Map<string, FileMutation>();

  constructor(private readonly base: RepositorySnapshot) {}

  async read(path: string): Promise<string | null> {
    assertSafePath(path);
    const staged = this.changes.get(path);
    return staged ? staged.content : this.base.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    assertSafePath(path);
    const existing = this.changes.get(path);
    this.changes.set(path, {
      path,
      content,
      expectedContent: existing ? existing.expectedContent : await this.base.read(path),
    });
  }

  async delete(path: string): Promise<void> {
    assertSafePath(path);
    const existing = this.changes.get(path);
    const expectedContent = existing ? existing.expectedContent : await this.base.read(path);
    if (expectedContent === null && !existing) return;
    this.changes.set(path, { path, content: null, expectedContent });
  }

  mutations(): FileMutation[] {
    return Array.from(this.changes.values())
      .filter((mutation) => mutation.content !== mutation.expectedContent)
      .sort((left, right) => left.path.localeCompare(right.path));
  }
}

async function requireText(snapshot: RepositorySnapshot, path: string): Promise<string> {
  const text = await snapshot.read(path);
  if (text === null) throw new ProposalValidationError(`Required target does not exist: ${path}`);
  return text;
}

async function loadMechanism(snapshot: RepositorySnapshot, id: string): Promise<Mechanism> {
  if (!MECHANISM_ID.test(id)) {
    throw new ProposalValidationError(`Invalid mechanism id: ${id}`);
  }
  const path = `registry/mechanisms/${id}.json`;
  return parseJson<Mechanism>(path, await requireText(snapshot, path));
}

async function mechanismExists(snapshot: RepositorySnapshot, id: string): Promise<boolean> {
  if (!MECHANISM_ID.test(id)) return false;
  return (
    (await snapshot.read(`registry/mechanisms/${id}.json`)) !== null ||
    (await snapshot.read(`registry/mechanisms/_seed/${id}.json`)) !== null
  );
}

async function validateMechanismReferences(
  snapshot: RepositorySnapshot,
  mechanism: Mechanism,
): Promise<void> {
  for (const relation of mechanism.relations) {
    if (!(await mechanismExists(snapshot, relation.target))) {
      throw new ProposalValidationError(
        `Mechanism ${mechanism.id} relation target does not exist: ${relation.target}`,
      );
    }
  }
  if (
    mechanism.dossier_ref !== null &&
    (await snapshot.read(mechanism.dossier_ref.replace(/^\/+/, ""))) === null
  ) {
    throw new ProposalValidationError(
      `Mechanism ${mechanism.id} dossier_ref does not exist: ${mechanism.dossier_ref}`,
    );
  }
  const effects = new Map<string, Effect>();
  for (const effectId of mechanism.effect_refs ?? []) {
    const path = `effects/${mechanism.id}/${effectId}.json`;
    const effect = parseJson<Effect>(path, await requireText(snapshot, path));
    if (effect.id !== effectId || effect.mechanism_id !== mechanism.id) {
      throw new ProposalValidationError(`Effect reference ${path} does not match its mechanism/id`);
    }
    effects.set(effectId, effect);
  }
  const implementationIds = new Set(mechanism.implementations.map((item) => item.id));
  if (implementationIds.size !== mechanism.implementations.length) {
    throw new ProposalValidationError(`Mechanism ${mechanism.id} has duplicate implementation ids`);
  }
  for (const implementation of mechanism.implementations) {
    if (implementation.effect_id && !effects.has(implementation.effect_id)) {
      throw new ProposalValidationError(
        `Implementation ${implementation.id} references missing effect ${implementation.effect_id}`,
      );
    }
  }
  for (const effect of Array.from(effects.values())) {
    for (const realizationId of effect.realization_ids) {
      if (!implementationIds.has(realizationId)) {
        throw new ProposalValidationError(
          `Effect ${effect.id} references missing realization ${realizationId}`,
        );
      }
    }
  }
}

async function projectEffect(
  builder: MutationBuilder,
  proposal: Extract<Proposal, { type: "effect" }>,
  validators: Validators,
): Promise<void> {
  const effect = proposal.payload;
  if (proposal.target !== effect.mechanism_id) {
    throw new ProposalValidationError("Effect target must equal payload.mechanism_id");
  }
  assertSafeComponent("effect id", effect.id);
  assertSchema("effect payload", validators.effect, effect);
  const mechanism = await loadMechanism(builder, proposal.target);
  const refs = Array.from(new Set([...(mechanism.effect_refs ?? []), effect.id])).sort();
  const nextMechanism: Mechanism = { ...mechanism, effect_refs: refs };
  await builder.write(`effects/${effect.mechanism_id}/${effect.id}.json`, json(effect));
  await builder.write(`registry/mechanisms/${mechanism.id}.json`, json(nextMechanism));
  assertSchema("projected mechanism", validators.mechanism, nextMechanism);
  await validateMechanismReferences(builder, nextMechanism);
}

async function projectRealization(
  builder: MutationBuilder,
  proposal: Extract<Proposal, { type: "realization" }>,
  validators: Validators,
): Promise<void> {
  const mechanism = await loadMechanism(builder, proposal.target);
  const implementation = proposal.payload;
  const index = mechanism.implementations.findIndex((item) => item.id === implementation.id);
  const implementations = [...mechanism.implementations];
  if (index === -1) implementations.push(implementation);
  else implementations[index] = implementation;
  const nextMechanism: Mechanism = { ...mechanism, implementations };
  assertSchema("projected mechanism", validators.mechanism, nextMechanism);
  await builder.write(`registry/mechanisms/${mechanism.id}.json`, json(nextMechanism));
  await validateMechanismReferences(builder, nextMechanism);
}

async function projectInteraction(
  builder: MutationBuilder,
  proposal: Extract<Proposal, { type: "interaction" }>,
  validators: Validators,
): Promise<void> {
  const interaction = proposal.payload;
  assertSchema("interaction payload", validators.interaction, interaction);
  const pair = [...interaction.pair].sort((left, right) => left.localeCompare(right)) as [
    string,
    string,
  ];
  if (pair[0] === pair[1] || canonical(pair) !== canonical(interaction.pair)) {
    throw new ProposalValidationError("Interaction pair must contain two distinct, sorted ids");
  }
  const pairId = `${pair[0]}__${pair[1]}`;
  if (proposal.target !== pairId) {
    throw new ProposalValidationError(`Interaction target must equal ${pairId}`);
  }
  for (const mechanismId of pair) {
    if (!(await mechanismExists(builder, mechanismId))) {
      throw new ProposalValidationError(`Interaction mechanism does not exist: ${mechanismId}`);
    }
  }
  await builder.write(`interactions/${pairId}.json`, json(interaction));
}

async function projectMechanism(
  builder: MutationBuilder,
  proposal: Extract<Proposal, { type: "mechanism" }>,
  validators: Validators,
): Promise<void> {
  const mechanism = proposal.payload;
  if (proposal.target !== mechanism.id) {
    throw new ProposalValidationError("Mechanism target must equal payload.id");
  }
  assertSchema("mechanism payload", validators.mechanism, mechanism);
  await builder.write(`registry/mechanisms/${mechanism.id}.json`, json(mechanism));
  await builder.delete(`registry/mechanisms/_seed/${mechanism.id}.json`);
  await validateMechanismReferences(builder, mechanism);
}

function assertDossierTotal(dossier: Dossier): void {
  const sum = Object.values(dossier.scores).reduce((total, axis) => total + axis.score, 0);
  if (dossier.total !== sum) {
    throw new ProposalValidationError(
      `Projected dossier total ${dossier.total} does not equal score sum ${sum}`,
    );
  }
}

async function projectDossierSection(
  builder: MutationBuilder,
  proposal: Extract<Proposal, { type: "dossier_section" }>,
  validators: Validators,
): Promise<void> {
  assertSafeComponent("dossier target", proposal.target);
  const path = `dossiers/${proposal.target}.json`;
  const dossier = parseJson<Dossier>(path, await requireText(builder, path));
  const payload = proposal.payload;
  const nextDossier = { ...dossier, [payload.field]: payload.value } as Dossier;
  assertSchema("projected dossier", validators.dossier, nextDossier);
  assertDossierTotal(nextDossier);
  if (!(await mechanismExists(builder, nextDossier.mechanism_id))) {
    throw new ProposalValidationError(
      `Projected dossier references missing mechanism ${nextDossier.mechanism_id}`,
    );
  }
  await builder.write(path, json(nextDossier));
}

function assertSegmentsFile(value: unknown): asserts value is SegmentsFile {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { version?: unknown }).version !== "string" ||
    !Array.isArray((value as { segments?: unknown }).segments)
  ) {
    throw new ProposalValidationError("segments/segments.yaml has an invalid root shape");
  }
  const ids = new Set<string>();
  for (const item of (value as SegmentsFile).segments) {
    if (
      !SAFE_COMPONENT.test(item.id) ||
      !["business-model", "form", "audience", "usage-rhythm"].includes(item.group) ||
      typeof item.definition !== "string" ||
      item.definition.length === 0 ||
      !["active", "retired"].includes(item.status) ||
      typeof item.provenance !== "string" ||
      item.provenance.length === 0
    ) {
      throw new ProposalValidationError(`Invalid segment record: ${canonical(item)}`);
    }
    if (ids.has(item.id)) throw new ProposalValidationError(`Duplicate segment id: ${item.id}`);
    ids.add(item.id);
  }
}

async function projectSegment(
  builder: MutationBuilder,
  proposal: Extract<Proposal, { type: "segment" }>,
): Promise<void> {
  const segment: Segment = proposal.payload;
  if (proposal.target !== segment.id) {
    throw new ProposalValidationError("Segment target must equal payload.id");
  }
  const path = "segments/segments.yaml";
  const document = parseYaml(await requireText(builder, path)) as unknown;
  assertSegmentsFile(document);
  const index = document.segments.findIndex((item) => item.id === segment.id);
  const segments = [...document.segments];
  if (index === -1) segments.push(segment);
  else segments[index] = segment;
  const next: SegmentsFile = { ...document, segments };
  assertSegmentsFile(next);
  await builder.write(path, stringifyYaml(next, { lineWidth: 0, sortMapEntries: false }));
}

async function projectApprovedProposal(
  builder: MutationBuilder,
  proposal: Proposal,
  validators: Validators,
): Promise<void> {
  switch (proposal.type) {
    case "effect":
      return projectEffect(builder, proposal, validators);
    case "realization":
      return projectRealization(builder, proposal, validators);
    case "interaction":
      return projectInteraction(builder, proposal, validators);
    case "mechanism":
      return projectMechanism(builder, proposal, validators);
    case "dossier_section":
      return projectDossierSection(builder, proposal, validators);
    case "segment":
      return projectSegment(builder, proposal);
  }
}

function nextDecisionId(log: DecisionsLog): string {
  const ids = log.decisions.map((decision) => {
    const match = /^D-(\d{3,})$/.exec(decision.id);
    if (!match) throw new ProposalValidationError(`Invalid decision id: ${decision.id}`);
    return Number(match[1]);
  });
  const next = Math.max(0, ...ids) + 1;
  return `D-${String(next).padStart(3, "0")}`;
}

function validateDecisionLog(log: DecisionsLog): void {
  if (!Array.isArray(log.decisions)) {
    throw new ProposalValidationError("decisions/decisions.json must contain decisions[]");
  }
  const ids = new Set<string>();
  for (const decision of log.decisions) {
    if (
      !/^D-\d{3,}$/.test(decision.id) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(decision.date) ||
      !decision.title ||
      !decision.body ||
      !["architecture", "data", "process", "stack", "operations"].includes(decision.area)
    ) {
      throw new ProposalValidationError(`Invalid decision entry: ${canonical(decision)}`);
    }
    if (ids.has(decision.id)) throw new ProposalValidationError(`Duplicate decision id: ${decision.id}`);
    ids.add(decision.id);
  }
}

export async function prepareProposalDecision(
  snapshot: RepositorySnapshot,
  request: ProposalDecisionRequest,
): Promise<PreparedProposalTransaction> {
  assertSafePath(request.proposalPath);
  assertIsoTimestamp(request.decidedAt);
  if (!request.decidedBy.trim()) {
    throw new ProposalValidationError("decidedBy is required");
  }
  const reason = request.reason?.trim();
  if (request.action === "reject" && !reason) {
    throw new ProposalValidationError("A non-empty reason is required to reject a proposal");
  }
  if (request.action === "edit" && request.editedPayload === undefined) {
    throw new ProposalValidationError("A complete payload is required to edit a proposal");
  }

  const validators = await getValidators(request.schemaRoot ?? process.cwd());
  const proposalText = await requireText(snapshot, request.proposalPath);
  const proposal = parseJson<Proposal>(request.proposalPath, proposalText);
  assertSchema("proposal envelope/payload", validators.proposal, proposal);
  assertSafeComponent("proposal id", proposal.id);
  const expectedPath = `proposals/${proposal.type}/${proposal.id}.json`;
  if (request.proposalPath !== expectedPath) {
    throw new ProposalValidationError(
      `Proposal path must match its type/id: expected ${expectedPath}`,
    );
  }
  assertPendingTransition(proposal.status, request.action);
  assertPayloadProvenance(proposal);

  const workingProposal =
    request.action === "edit"
      ? ({ ...proposal, payload: request.editedPayload } as Proposal)
      : proposal;
  assertSchema("edited proposal envelope/payload", validators.proposal, workingProposal);
  assertPayloadProvenance(workingProposal);

  const builder = new MutationBuilder(snapshot);
  if (request.action === "approve") {
    await projectApprovedProposal(builder, workingProposal, validators);
  }

  const decidedProposal: Proposal =
    request.action === "edit"
      ? {
          ...workingProposal,
          status: "edited",
          decided_by: null,
          decided_at: null,
          decision_note: null,
        }
      : {
          ...workingProposal,
          status: request.action === "approve" ? "approved" : "rejected",
          decided_by: request.decidedBy.trim(),
          decided_at: request.decidedAt,
          decision_note: reason ?? null,
        };
  assertSchema("decided proposal", validators.proposal, decidedProposal);
  await builder.write(request.proposalPath, json(decidedProposal));

  const decisionsPath = "decisions/decisions.json";
  const decisions = parseJson<DecisionsLog>(
    decisionsPath,
    await requireText(builder, decisionsPath),
  );
  validateDecisionLog(decisions);
  const decisionId = nextDecisionId(decisions);
  const actionPast =
    request.action === "approve"
      ? "approved"
      : request.action === "reject"
        ? "rejected"
        : "edited";
  const nextDecisions: DecisionsLog = {
    decisions: [
      ...decisions.decisions,
      {
        id: decisionId,
        date: request.decidedAt.slice(0, 10),
        title: `Proposal ${proposal.id} ${actionPast}`,
        body:
          `Owner ${request.decidedBy.trim()} ${actionPast} ${proposal.type} proposal ` +
          `${proposal.id} for ${proposal.target}. ` +
          (request.action === "approve"
            ? "The validated proposal status and authoritative projection were committed atomically."
            : request.action === "reject"
              ? `No authoritative artifact was changed. Reason: ${reason}`
              : "The validated proposal payload was updated for further review. No authoritative artifact was changed."),
        area: "data",
      },
    ],
  };
  validateDecisionLog(nextDecisions);
  await builder.write(decisionsPath, json(nextDecisions));

  const mutations = builder.mutations();
  if (request.action !== "approve") {
    const allowed = new Set([request.proposalPath, decisionsPath]);
    const artifactMutation = mutations.find((mutation) => !allowed.has(mutation.path));
    if (artifactMutation) {
      throw new ProposalValidationError(
        `${actionPast} proposal unexpectedly mutated artifact ${artifactMutation.path}`,
      );
    }
  }
  return {
    action: request.action,
    proposalId: proposal.id,
    proposalType: proposal.type,
    decisionId,
    commitMessage: `data: ${actionPast} ${proposal.type} proposal ${proposal.id}`,
    mutations,
  };
}
