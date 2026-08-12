/**
 * Transferability: can a product generator act on this claim at all? (D-160)
 *
 * Asked of a GROUNDED claim, at extraction, before it becomes a proposal. The
 * question is not whether the claim is true — grounding already established
 * that it is what the source said — but whether it says anything an interface
 * can do something about. A true finding about pathology residents reading
 * whole slides is not false; it is unusable, and the queue should not spend a
 * reader on it.
 *
 * Three constraints shape everything here:
 *
 * 1. It judges the CLAIM ONLY — fact, boundary, source title. It never opens
 *    the source record, which is why it costs nothing and can be replayed
 *    offline from the proposal file alone.
 * 2. It is DETERMINISTIC. No model call. A rule that asks a model whether a
 *    claim is transferable reintroduces the judgement it exists to replace, and
 *    could not be replayed years later against the same inputs.
 * 3. It FAILS OPEN. Nothing here drops a candidate or writes reader coverage.
 *    A refusal produces a held proposal carrying this verdict; the record
 *    survives, and so does the reasoning that set it aside.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { GENERIC_UI_TERMS } from "./review-flags";
import { OVERLAP_STOPWORDS } from "./span-role";
import {
  TRANSFERABILITY_CHECKS,
  type Effect,
  type Mechanism,
  type PackMapFile,
  type Proposal,
  type Realization,
  type TransferabilityCheck,
  type TransferabilityCheckResult,
  type TransferabilityVerdict,
  type VariableJudgement,
} from "./types";

/**
 * Bump on any rule change, and record the change as a decision. A stored
 * verdict is only interpretable next to the rules that produced it, and
 * "the lexicon quietly grew a word" is precisely the drift this number exists
 * to make visible.
 *
 * v1 (D-160): all four checks deterministic; VARIABLE is a word list.
 * v2 (D-162): VARIABLE is a cheap model judgement returning a named lever;
 *             SUBJECT, DIRECTION and POPULATION stay the same deterministic
 *             checks. v1 is kept, not deleted — old verdicts still replay
 *             against it, and it remains the offline path for the three checks
 *             that never needed a model.
 * v3 (D-165): the named lever decides, alone. VARIABLE finding no lever is the
 *             only refusal left; SUBJECT, DIRECTION and POPULATION still run,
 *             still state reasons, and are recorded as confidence MODIFIERS
 *             that never refuse. Measured cause: of ten LA-01 refusals under
 *             v2, eight were made by SUBJECT or DIRECTION on claims whose lever
 *             VARIABLE had already named — SUBJECT was filtering on where the
 *             study ran ("public budgeting decisions", "rural villagers",
 *             "salaried employees in India") rather than on whether the lever
 *             applies, and DIRECTION refused definitions whose direction is in
 *             their name (house money, hyperopic loss aversion, gain/loss
 *             framing). The two correct refusals were both VARIABLE returning
 *             no lever, which is the check doing its job.
 */
export const TRANSFERABILITY_RULESET_VERSION = 1;
export const TRANSFERABILITY_RULESET_VERSION_V2 = 2;
export const TRANSFERABILITY_RULESET_VERSION_V3 = 3;

export interface TransferabilityClaim {
  /** The claim itself. */
  fact: string;
  /** Where the claim was said to hold. */
  boundary: string;
  /** The cited source's title — often the only place the setting is named. */
  source_title: string;
}

/**
 * Words an interface can SET. Grouped by what kind of change they describe,
 * because the reason string should say which lever was found, not merely that
 * one was.
 *
 * Deliberately absent: "interface", "design", "system", "technology". Those
 * name the object being changed, not a change; admitting them would pass every
 * claim that mentions software at all.
 */
const VARIABLE_LEXICONS: Record<string, readonly string[]> = {
  layout: [
    "layout",
    "integrated",
    "integration",
    "split",
    "split-attention",
    "spatial",
    "position",
    "positioned",
    "placement",
    "proximity",
    "adjacent",
    "adjacency",
    "contiguity",
    "arrangement",
    "grouping",
    "grouped",
    "separated",
    "side-by-side",
    "format",
    "formatting",
    "density",
    "whitespace",
  ],
  sequence: [
    "sequence",
    "sequencing",
    "sequential",
    "order",
    "ordering",
    "stepwise",
    "steps",
    "progressive",
    "disclosure",
    "staged",
    "preceded",
    "beforehand",
    "subsequent",
  ],
  timing: [
    "timing",
    "duration",
    "delay",
    "delayed",
    "latency",
    "simultaneous",
    "simultaneously",
    "synchronous",
    "synchronised",
    "synchronized",
    "asynchronous",
    "pacing",
    "paced",
    "interval",
    "immediate",
    "immediately",
    "time pressure",
  ],
  wording: [
    "wording",
    "phrasing",
    "phrased",
    "label",
    "labels",
    "labelled",
    "labeled",
    "terminology",
    "instructions",
    "wordy",
    "verbose",
    "headline",
    "caption",
    "captions",
    "naming",
  ],
  visibility: [
    "visibility",
    "visible",
    "hidden",
    "salience",
    "salient",
    "highlight",
    "highlighted",
    "highlighting",
    "cue",
    "cues",
    "cueing",
    "cued",
    "signalling",
    "signaling",
    "contrast",
    "colour",
    "color",
    "background",
    "backgrounds",
    "foreground",
    "prominence",
    "emphasis",
    "emphasised",
    "emphasized",
    "redundant",
    "redundancy",
    "omitted",
    "removed",
    "font",
    "typeface",
    "legibility",
  ],
  feedback: [
    "feedback",
    "confirmation",
    "haptic",
    "reward",
    "rewards",
    "prompt",
    "prompts",
    "prompting",
    "nudge",
    "notification",
    "reminder",
    "guidance",
    "scaffolding",
    "scaffolded",
    "hints",
    "worked example",
    "worked examples",
  ],
  modality: [
    "modality",
    "auditory",
    "audio",
    "spoken",
    "narration",
    "narrated",
    "verbal",
    "visual",
    "textual",
    "written",
    "multimodal",
    "multimedia",
    "gesture",
    "gestures",
    "tracing",
    "pointing",
    "touch",
    "animation",
    "animated",
    "video",
    "imagery",
    "diagram",
    "diagrams",
    "picture",
    "pictures",
    "illustration",
    "speech",
  ],
};

/** A claim states a direction when one of these appears. */
const DIRECTIONAL_MARKERS = [
  "increase",
  "increases",
  "increased",
  "decrease",
  "decreases",
  "decreased",
  "reduce",
  "reduces",
  "reduced",
  "reduction",
  "raise",
  "raises",
  "raised",
  "lower",
  "lowers",
  "lowered",
  "improve",
  "improves",
  "improved",
  "improvement",
  "enhance",
  "enhances",
  "enhanced",
  "impair",
  "impairs",
  "impaired",
  "harm",
  "harms",
  "hinder",
  "hinders",
  "hindered",
  "degrade",
  "degrades",
  "boost",
  "boosts",
  "facilitate",
  "facilitates",
  "accelerate",
  "accelerates",
  "slower",
  "faster",
  "quicker",
  "higher",
  "greater",
  "better",
  "worse",
  "outperform",
  "outperforms",
  "outperformed",
  "optimize",
  "optimizes",
  "optimise",
  "optimises",
  "suppress",
  "suppresses",
  "suppressed",
  "amplify",
  "amplifies",
  "weaken",
  "weakens",
  "expand",
  "expands",
  "exceed",
  "exceeds",
  "benefit",
  "benefits",
  "beneficial",
  "detrimental",
  "superior",
  "inferior",
  "more effective",
  "less effective",
  "leads to",
  "results in",
  "than",
];

/**
 * Markers of a claim that DESCRIBES rather than states a direction. A claim can
 * carry a directional word and still be one of these — "Memory Drift is a
 * phenomenon characterized by the gradual loss of context" contains "loss" and
 * asserts nothing anyone can do — so these override.
 */
const DESCRIPTIVE_MARKERS = [
  "is a phenomenon",
  "is the phenomenon",
  "characterized by",
  "characterised by",
  "refers to",
  "is defined as",
  "can be defined",
  "describes how",
  "is a framework",
  "framework for",
  "a conceptual",
  "is associated with",
  "correlates with",
  "correlation between",
  "consists of",
  "is a construct",
  "is a process by which",
];

/**
 * Relations that are structural rather than directional. "X mediates Y" places
 * X on a path; it does not say which way to move it.
 */
const STRUCTURAL_RELATION_MARKERS = [
  "mediates",
  "mediated the relationship",
  "mediating",
  "mediation",
  "moderates",
  "moderating",
  "is determined by",
  "is influenced by",
];

/** Someone the claim could be about. */
const PERSON_MARKERS = [
  "people",
  "person",
  "user",
  "users",
  "reader",
  "readers",
  "viewer",
  "viewers",
  "participant",
  "participants",
  "individual",
  "individuals",
  "adult",
  "adults",
  "child",
  "children",
  "human",
  "humans",
  "learner",
  "learners",
  "student",
  "students",
  "novice",
  "novices",
  "expert",
  "experts",
  "trainee",
  "trainees",
  "patient",
  "patients",
  "audience",
  "consumer",
  "consumers",
  "customer",
  "customers",
  "subject",
  "subjects",
  "respondents",
];

/** Something a person could be interacting with. */
const ARTIFACT_MARKERS = [
  "interface",
  "interfaces",
  "screen",
  "screens",
  "display",
  "page",
  "pages",
  "website",
  "app",
  "application",
  "button",
  "menu",
  "form",
  "dashboard",
  "presentation",
  "material",
  "materials",
  "text",
  "layout",
  "background",
  "backgrounds",
  "diagram",
  "diagrams",
  "animation",
  "video",
  "image",
  "images",
  "picture",
  "pictures",
  "multimedia",
  "instructions",
  "document",
  "documents",
  "notification",
  "checkout",
  "onboarding",
];

/**
 * A specific institutional setting the claim sits inside. Presence of one of
 * these decides the subject even when an artifact is also named: a slide viewer
 * in a pathology course is still a pathology course. That is a warning, not a
 * refusal — a classroom finding about layout may well transfer — but the
 * setting is a fact about the claim and should be recorded as one.
 */
const INSTITUTIONAL_MARKERS = [
  "classroom",
  "class",
  "school",
  "university",
  "undergraduate",
  "postgraduate",
  "curriculum",
  "coursework",
  "course",
  "lesson",
  "lessons",
  "lecture",
  "pedagogy",
  "pedagogical",
  "instructional",
  "instruction",
  "education",
  "educational",
  "teaching",
  "training programme",
  "training program",
  "clinic",
  "clinical",
  "hospital",
  "medical",
  "nursing",
  "conservatory",
  "workplace",
  "vocational",
  "exam",
  "examination",
  "homework",
  "tutoring",
  "learning",
];

/**
 * Expertise a general product user does not have. Not "does the study use a
 * specialised population" — most do — but "does the CLAIM depend on that
 * expertise to make sense".
 */
const SPECIALIST_POPULATION_MARKERS = [
  "radiologist",
  "radiologists",
  "pathologist",
  "pathologists",
  "clinician",
  "clinicians",
  "physician",
  "physicians",
  "surgeon",
  "surgeons",
  "nurse",
  "nurses",
  "resident",
  "residents",
  "medical student",
  "medical students",
  "accounting student",
  "accounting students",
  "accountant",
  "accountants",
  "auditor",
  "auditors",
  "conservatory",
  "vocal",
  "singer",
  "singers",
  "bel canto",
  "musician",
  "musicians",
  "pilot",
  "pilots",
  "air traffic",
  "pre-service teacher",
  "pre-service teachers",
  "teacher trainee",
  "engineering student",
  "engineering students",
  "law student",
  "law students",
  "apprentice",
  "apprentices",
  "domain expert",
  "domain experts",
  "specialist",
  "specialists",
  "professional",
  "professionals",
  "practitioner",
  "practitioners",
  "histology",
  "pathology",
  "radiology",
  "anatomy",
  "surgical",
  "diagnostic",
];

function normalise(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9+-]+/g, " ").replace(/\s+/g, " ")} `;
}

/** Whole-phrase match, so "class" does not fire inside "classification". */
function hits(haystack: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => haystack.includes(` ${needle} `));
}

function list(values: readonly string[], limit = 4): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown}, +${values.length - limit} more` : shown;
}

function judgeSubject(contextText: string): TransferabilityCheckResult {
  const institutional = hits(contextText, INSTITUTIONAL_MARKERS);
  const artifacts = hits(contextText, ARTIFACT_MARKERS);
  const people = hits(contextText, PERSON_MARKERS);

  // Neither a person nor a thing a person uses: the subject is a system, a
  // construct, or a phenomenon. This is the check that catches a claim about
  // machine memory filed under a mechanism about human memory.
  if (people.length === 0 && artifacts.length === 0) {
    return {
      check: "subject",
      outcome: "fail",
      reason:
        "no person and no artifact named — the subject is a system, construct, or phenomenon, " +
        "which is neither of the two subjects a transferable claim can have",
    };
  }
  if (institutional.length > 0) {
    return {
      check: "subject",
      outcome: "warn",
      reason: `a person inside a specific institutional setting (${list(institutional)}) — transferable only if the finding survives leaving it`,
    };
  }
  if (artifacts.length > 0) {
    return {
      check: "subject",
      outcome: "pass",
      reason: `a person interacting with an artifact (${list(artifacts)})`,
    };
  }
  return {
    check: "subject",
    outcome: "warn",
    reason: `people (${list(people)}) but no artifact and no named setting — the subject is a person in the abstract`,
  };
}

function judgeVariable(claimText: string): TransferabilityCheckResult {
  const found = Object.entries(VARIABLE_LEXICONS)
    .map(([lever, words]) => [lever, hits(claimText, words)] as const)
    .filter(([, words]) => words.length > 0);
  if (found.length === 0) {
    return {
      check: "variable",
      outcome: "fail",
      reason:
        "names nothing an interface can change — looked for " +
        `${Object.keys(VARIABLE_LEXICONS).join(", ")}, found none`,
    };
  }
  const described = found
    .map(([lever, words]) => `${lever} (${list(words, 3)})`)
    .join("; ");
  return {
    check: "variable",
    outcome: "pass",
    reason: `names a manipulable variable: ${described}`,
  };
}

function judgeDirection(claimText: string): TransferabilityCheckResult {
  const descriptive = hits(claimText, DESCRIPTIVE_MARKERS);
  if (descriptive.length > 0) {
    return {
      check: "direction",
      outcome: "fail",
      reason: `describes rather than directs (${list(descriptive, 2)}) — a definition states nothing to move`,
    };
  }
  const directional = hits(claimText, DIRECTIONAL_MARKERS);
  const structural = hits(claimText, STRUCTURAL_RELATION_MARKERS);
  if (directional.length === 0 && structural.length > 0) {
    return {
      check: "direction",
      outcome: "fail",
      reason: `states a structural relation (${list(structural, 2)}) but no direction — a path is not an instruction`,
    };
  }
  if (directional.length === 0) {
    return {
      check: "direction",
      outcome: "fail",
      reason: "no directional term — nothing is said to raise, lower, or outperform anything",
    };
  }
  return {
    check: "direction",
    outcome: "pass",
    reason: `states a direction (${list(directional, 3)})`,
  };
}

function judgePopulation(contextText: string): TransferabilityCheckResult {
  const specialists = hits(contextText, SPECIALIST_POPULATION_MARKERS);
  if (specialists.length > 0) {
    return {
      check: "population",
      outcome: "warn",
      reason: `depends on domain expertise the general product user lacks (${list(specialists)})`,
    };
  }
  return {
    check: "population",
    outcome: "pass",
    reason: "no specialist population named — the claim does not require expertise to apply",
  };
}

/**
 * Scoring, as the owner specified it:
 *
 *   - failing VARIABLE or DIRECTION is a refusal on its own; a claim with no
 *     manipulable variable, or with no direction, cannot be acted on however
 *     true it is;
 *   - failing SUBJECT outright (no person, no artifact) is a refusal too,
 *     because the claim is not about a human being at all;
 *   - a SUBJECT warning or a POPULATION warning ALONE is a warning, not a
 *     refusal — a classroom finding about layout may still transfer.
 *
 * The one rule the owner did not state outright, named here so it can be
 * overruled: the two warnings TOGETHER refuse. A claim that is both bound to an
 * institution and dependent on expertise has nothing left that travels. It is
 * flagged as `escalated_by_warning_pair` so this rule's effect can always be
 * measured separately from the rest.
 */
/**
 * The scoring, shared by every ruleset version so it can never drift between
 * them. Given the four check outcomes it returns the verdict fields: any `fail`
 * refuses; absent a fail, two or more `warn`s refuse and are flagged as the
 * escalation the owner did not specify outright.
 */
function scoreChecks(checks: TransferabilityCheckResult[]): {
  transferable: boolean;
  escalated_by_warning_pair: boolean;
} {
  const refused = checks.some((result) => result.outcome === "fail");
  const warnings = checks.filter((result) => result.outcome === "warn");
  const escalated = !refused && warnings.length >= 2;
  return { transferable: !refused && !escalated, escalated_by_warning_pair: escalated };
}

export function judgeTransferability(
  claim: TransferabilityClaim,
): TransferabilityVerdict {
  const claimText = normalise(`${claim.fact} ${claim.boundary}`);
  const contextText = normalise(
    `${claim.fact} ${claim.boundary} ${claim.source_title}`,
  );

  const results: Record<TransferabilityCheck, TransferabilityCheckResult> = {
    subject: judgeSubject(contextText),
    variable: judgeVariable(claimText),
    direction: judgeDirection(claimText),
    population: judgePopulation(contextText),
  };
  const checks = TRANSFERABILITY_CHECKS.map((check) => results[check]);

  return {
    ruleset_version: TRANSFERABILITY_RULESET_VERSION,
    ...scoreChecks(checks),
    checks,
  };
}

/**
 * The three checks that never needed a model. Shared by v1 (via judgeSubject
 * etc. above) and v2, which recomputes exactly these offline while trusting the
 * stored VARIABLE lever it cannot re-derive.
 */
function judgeDeterministicChecks(claim: TransferabilityClaim): {
  subject: TransferabilityCheckResult;
  direction: TransferabilityCheckResult;
  population: TransferabilityCheckResult;
} {
  const claimText = normalise(`${claim.fact} ${claim.boundary}`);
  const contextText = normalise(
    `${claim.fact} ${claim.boundary} ${claim.source_title}`,
  );
  return {
    subject: judgeSubject(contextText),
    direction: judgeDirection(claimText),
    population: judgePopulation(contextText),
  };
}

/** The prompt the v2 VARIABLE model reads. Pure, so the exact text a stored
 * verdict was produced under stays inspectable and versioned in git alongside
 * the ruleset number. It asks one question and demands a named lever or null. */
export function buildVariablePrompt(claim: TransferabilityClaim): string {
  return [
    "You are the VARIABLE check of a transferability filter for a consumer-product",
    "motivation knowledge base. You read a research finding as three fields: fact,",
    "boundary, source_title. Answer ONE question: could a digital product surface",
    "(a screen, UI element, message, notification, or flow) act on the MECHANISM",
    "this finding describes by SHOWING, HIDING, REORDERING, COUNTING, TIMING, or",
    "REWORDING something? Map the underlying construct to the nearest concrete",
    "interface lever even when the finding is phrased abstractly as a 'principle',",
    "'effect', or 'technique', and even when its study setting is a classroom,",
    "clinic, market, or lab — the setting does not disqualify a mechanism a product",
    "could use.",
    "",
    "Return transferable=true and a lever of 8 words or fewer when such a lever",
    "exists (examples: 'count of other users who did X', 'countdown timer',",
    "'ask a small request before the larger one', 'progress bar toward a goal').",
    "Return transferable=false and lever=null ONLY when no product surface could",
    "act on it: a bare definition with no actionable mechanism, a population,",
    "finance, or market statistic, a chemistry/biology/clinical result, a historical",
    "or literary analysis, or a purely internal state with no surface control.",
    "Judge whether a lever EXISTS, not whether the study proves it works.",
    "",
    "Output STRICT JSON only, no prose:",
    '{"transferable": true, "lever": "…", "reason": "20 words max"}',
    "",
    `fact: ${claim.fact}`,
    `boundary: ${claim.boundary}`,
    `source_title: ${claim.source_title}`,
  ].join("\n");
}

/**
 * Parse the model's VARIABLE answer defensively. Anything that is not a clean,
 * on-contract object is treated as "no judgement" (null), so a malformed model
 * response can never be mistaken for a confident verdict — the caller fails
 * open on null rather than inventing a lever.
 */
export function parseVariableJudgement(raw: unknown): VariableJudgement | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      value = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.transferable !== "boolean") return null;
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    return null;
  }
  const lever =
    typeof record.lever === "string" && record.lever.trim().length > 0
      ? record.lever.trim()
      : null;
  // A transferable verdict with no lever is incoherent — the whole point is the
  // named lever — and a non-transferable verdict must not carry one.
  if (record.transferable && !lever) return null;
  return { transferable: record.transferable, lever: record.transferable ? lever : null, reason: record.reason.trim() };
}

/** The VARIABLE check result built from a model judgement (v2). */
export function variableCheckFromJudgement(
  judgement: VariableJudgement,
): TransferabilityCheckResult {
  return {
    check: "variable",
    outcome: judgement.transferable ? "pass" : "fail",
    reason: judgement.transferable
      ? `names a manipulable variable: ${judgement.lever} — ${judgement.reason}`
      : `names nothing an interface can change — ${judgement.reason}`,
    identified_lever: judgement.lever,
  };
}

/**
 * The v2 verdict: SUBJECT, DIRECTION and POPULATION recomputed deterministically,
 * VARIABLE taken from the model judgement, scored by the same shared rule and
 * stamped ruleset v2. Pure given the judgement, so the whole verdict is
 * re-derivable offline from (claim + stored lever) without another model call.
 */
export function judgeTransferabilityV2(
  claim: TransferabilityClaim,
  variable: VariableJudgement,
): TransferabilityVerdict {
  const deterministic = judgeDeterministicChecks(claim);
  const results: Record<TransferabilityCheck, TransferabilityCheckResult> = {
    subject: deterministic.subject,
    variable: variableCheckFromJudgement(variable),
    direction: deterministic.direction,
    population: deterministic.population,
  };
  const checks = TRANSFERABILITY_CHECKS.map((check) => results[check]);
  return {
    ruleset_version: TRANSFERABILITY_RULESET_VERSION_V2,
    ...scoreChecks(checks),
    checks,
  };
}

/**
 * The v3 scoring: the lever decides, alone.
 *
 * Kept separate from `scoreChecks` rather than parameterising it, because the
 * combination rule is exactly what changed and a shared function with a version
 * branch inside would make the two rules look like one rule with an option.
 * Every non-VARIABLE check that did not pass is returned as a modifier — the
 * flag survives on an admitted verdict instead of disappearing with the refusal
 * it used to cause.
 */
function scoreChecksV3(checks: TransferabilityCheckResult[]): {
  transferable: boolean;
  modifiers_flagged: TransferabilityCheck[];
} {
  const variable = checks.find((result) => result.check === "variable");
  const modifiers_flagged = checks
    .filter((result) => result.check !== "variable" && result.outcome !== "pass")
    .map((result) => result.check);
  return { transferable: variable?.outcome === "pass", modifiers_flagged };
}

/**
 * The v3 verdict: same four checks computed exactly as v2 computes them, scored
 * so that only VARIABLE can refuse. `escalated_by_warning_pair` is always false
 * — there is no escalation path left to describe — and the warnings it used to
 * summarise are carried by `modifiers_flagged` instead.
 */
export function judgeTransferabilityV3(
  claim: TransferabilityClaim,
  variable: VariableJudgement,
): TransferabilityVerdict {
  const deterministic = judgeDeterministicChecks(claim);
  const results: Record<TransferabilityCheck, TransferabilityCheckResult> = {
    subject: deterministic.subject,
    variable: variableCheckFromJudgement(variable),
    direction: deterministic.direction,
    population: deterministic.population,
  };
  const checks = TRANSFERABILITY_CHECKS.map((check) => results[check]);
  const { transferable, modifiers_flagged } = scoreChecksV3(checks);
  return {
    ruleset_version: TRANSFERABILITY_RULESET_VERSION_V3,
    transferable,
    checks,
    escalated_by_warning_pair: false,
    modifiers_flagged,
  };
}

/**
 * The claim a proposal makes, in the three fields the rules read — or null when
 * the rules do not apply to it.
 *
 * Scoped to EFFECTS on purpose. An L2 effect is a claim about people that the
 * product layer has to translate, which is exactly where transferability is
 * decidable. A realization already describes a shipped interface, so asking
 * whether it names a manipulable variable answers itself; a mechanism or
 * dossier is a container rather than a claim. Judging those would produce
 * confident verdicts about the wrong question.
 */
export function transferabilityClaimOfProposal(
  proposal: Proposal,
): TransferabilityClaim | null {
  if (proposal.type !== "effect") return null;
  const payload = proposal.payload as Effect | undefined;
  if (!payload || typeof payload.fact !== "string") return null;
  return {
    fact: payload.fact,
    boundary: typeof payload.boundary === "string" ? payload.boundary : "",
    // The setting is often named nowhere but the title: "…in Bel Canto
    // education", "…in medical education". Dropping it would blind the subject
    // and population checks to the only place the claim admits where it lives.
    source_title: proposal.provenance
      .map((item) => ("title" in item && typeof item.title === "string" ? item.title : ""))
      .join(" "),
  };
}

/** One-line summary for reports and commit messages. */
export function describeTransferability(verdict: TransferabilityVerdict): string {
  // v3 reads differently on purpose: a flagged modifier is part of an ADMITTED
  // verdict, so a summary that said only "transferable" would drop the one thing
  // v3 added. And its single refusal path is named, so a reader never has to
  // infer which check refused.
  if (verdict.ruleset_version === TRANSFERABILITY_RULESET_VERSION_V3) {
    const modifiers = verdict.modifiers_flagged ?? [];
    if (verdict.transferable) {
      return modifiers.length > 0
        ? `transferable (modifiers: ${modifiers.join(", ")})`
        : "transferable";
    }
    return "not transferable — VARIABLE named no lever an interface can act on";
  }
  if (verdict.transferable) return "transferable";
  const refusals = verdict.checks
    .filter((result) => result.outcome === "fail")
    .map((result) => result.check);
  if (refusals.length > 0) return `not transferable — failed ${refusals.join(", ")}`;
  return "not transferable — two warnings (subject and population)";
}

/**
 * Whether a stored verdict still matches what the current rules say about the
 * same claim. Replay is only meaningful if drift has a name: a stored verdict
 * that silently disagrees with today's ruleset is the failure mode, not the
 * recomputation itself.
 */
export function transferabilityDrift(
  stored: TransferabilityVerdict,
  recomputed: TransferabilityVerdict,
): string | null {
  if (stored.ruleset_version !== recomputed.ruleset_version) {
    return `stored under ruleset v${stored.ruleset_version}, replayed under v${recomputed.ruleset_version}`;
  }
  if (stored.transferable !== recomputed.transferable) {
    return `verdict changed: stored ${describeTransferability(stored)}, replayed ${describeTransferability(recomputed)}`;
  }
  const changed = recomputed.checks.filter((result, index) => {
    const before = stored.checks[index];
    return (
      before === undefined ||
      before.check !== result.check ||
      before.outcome !== result.outcome
    );
  });
  if (changed.length > 0) {
    return `same verdict, different reasoning: ${changed.map((result) => `${result.check}=${result.outcome}`).join(", ")}`;
  }
  return null;
}

/**
 * Replay a stored verdict against today's rules, dispatching by ruleset version.
 * This is the single entry point validate.ts and the replay tool call, so the
 * "how do we re-check a stored verdict" decision lives in one place.
 *
 * v1 recomputes all four checks and demands an exact match — the D-160 contract.
 *
 * v2 CANNOT recompute VARIABLE offline: it was a model call, and re-running the
 * model would be non-deterministic, cost money, and defeat the point of storing
 * the lever. So v2 is AUDITED, not recomputed (D-162):
 *   - SUBJECT, DIRECTION and POPULATION are deterministic and ARE recomputed and
 *     compared exactly, so drift in the three rule-based checks still fails loud;
 *   - VARIABLE is audited structurally — it must be pass or fail, carry a
 *     non-empty reason, and carry a non-null identified_lever exactly when it
 *     passed;
 *   - the scoring is recomputed from the stored checks and must match the stored
 *     transferable / escalation, so a tampered verdict body cannot survive.
 * What this deliberately does not catch is the model changing its mind about a
 * lever. That is not drift in the rules; it is a new judgement, and it only
 * enters the store through a fresh extraction run that stamps its own verdict.
 */
export function replayTransferability(
  stored: TransferabilityVerdict,
  claim: TransferabilityClaim,
): string | null {
  if (stored.ruleset_version === TRANSFERABILITY_RULESET_VERSION) {
    return transferabilityDrift(stored, judgeTransferability(claim));
  }
  if (stored.ruleset_version === TRANSFERABILITY_RULESET_VERSION_V2) {
    return auditTransferabilityV2(stored, claim);
  }
  if (stored.ruleset_version === TRANSFERABILITY_RULESET_VERSION_V3) {
    return auditTransferabilityV3(stored, claim);
  }
  return `stored under unrecognised ruleset v${stored.ruleset_version}`;
}

function findCheck(
  verdict: Pick<TransferabilityVerdict, "checks">,
  check: TransferabilityCheck,
): TransferabilityCheckResult | undefined {
  return verdict.checks.find((result) => result.check === check);
}

/**
 * The part of the audit v2 and v3 share: the three deterministic checks are
 * recomputed and compared exactly, and VARIABLE — which cannot be recomputed
 * without the model that produced it — is audited structurally.
 *
 * Shared because D-165 made v3's SUBJECT/DIRECTION/POPULATION computation
 * byte-identical to v2's on purpose (both call judgeDeterministicChecks), so
 * that the two rulesets differ in scoring alone. Auditing them from one function
 * is that guarantee expressed in code: if the two ever drifted apart, this would
 * stop compiling rather than quietly start checking two different things.
 *
 * What it deliberately does NOT verify is the scoring — that is the part that
 * differs, and each ruleset's own audit applies its own rule to the stored
 * checks so a tampered verdict body cannot survive.
 */
function auditSharedStructure(
  stored: TransferabilityVerdict,
  claim: TransferabilityClaim,
): string | null {
  if (stored.checks.length !== TRANSFERABILITY_CHECKS.length) {
    return `expected ${TRANSFERABILITY_CHECKS.length} checks, stored ${stored.checks.length}`;
  }
  const deterministic = judgeDeterministicChecks(claim);
  for (const check of ["subject", "direction", "population"] as const) {
    const before = findCheck(stored, check);
    const now = deterministic[check];
    if (!before) return `${check} check missing from stored verdict`;
    if (before.outcome !== now.outcome) {
      return `${check} drifted: stored ${before.outcome}, replayed ${now.outcome}`;
    }
    if (before.reason !== now.reason) {
      return `${check} reasoning drifted under the current rules`;
    }
  }
  const variable = findCheck(stored, "variable");
  if (!variable) return "variable check missing from stored verdict";
  if (variable.outcome !== "pass" && variable.outcome !== "fail") {
    return `variable outcome must be pass or fail, stored ${variable.outcome}`;
  }
  if (typeof variable.reason !== "string" || variable.reason.trim().length === 0) {
    return "variable check carries no reason";
  }
  const leverPresent =
    typeof variable.identified_lever === "string" &&
    variable.identified_lever.trim().length > 0;
  if (variable.outcome === "pass" && !leverPresent) {
    return "variable passed but named no lever";
  }
  if (variable.outcome === "fail" && leverPresent) {
    return "variable failed yet carries a lever";
  }
  return null;
}

/**
 * The v3 audit: shared structure, then v3's own scoring rule.
 *
 * Every claim v3 makes about itself is re-derived from its own stored checks —
 * that the lever alone decided it, that no escalation happened, and that the
 * modifiers recorded are exactly the non-VARIABLE checks that did not pass. A
 * verdict edited to admit a claim VARIABLE refused, or to drop a modifier that
 * would have flagged it, fails here rather than passing as history.
 */
function auditTransferabilityV3(
  stored: TransferabilityVerdict,
  claim: TransferabilityClaim,
): string | null {
  const structural = auditSharedStructure(stored, claim);
  if (structural) return structural;

  const score = scoreChecksV3(stored.checks);
  if (score.transferable !== stored.transferable) {
    return `stored transferable=${stored.transferable} disagrees with its own checks`;
  }
  // Not merely "should be false" — under v3 there is no scoring path that can
  // set it, so a true here means the verdict was written by something other than
  // scoreChecksV3.
  if (stored.escalated_by_warning_pair) {
    return "escalated_by_warning_pair is true on a v3 verdict, which has no escalation path";
  }
  const storedModifiers = stored.modifiers_flagged;
  if (!Array.isArray(storedModifiers)) {
    return "v3 verdict carries no modifiers_flagged";
  }
  const expected = score.modifiers_flagged;
  const sameSet =
    storedModifiers.length === expected.length &&
    expected.every((check) => storedModifiers.includes(check));
  if (!sameSet) {
    return (
      `modifiers_flagged disagrees with its own checks: stored [${storedModifiers.join(", ")}], ` +
      `replayed [${expected.join(", ")}]`
    );
  }
  return null;
}

function auditTransferabilityV2(
  stored: TransferabilityVerdict,
  claim: TransferabilityClaim,
): string | null {
  const structural = auditSharedStructure(stored, claim);
  if (structural) return structural;

  const score = scoreChecks(stored.checks);
  if (score.transferable !== stored.transferable) {
    return `stored transferable=${stored.transferable} disagrees with its own checks`;
  }
  if (score.escalated_by_warning_pair !== stored.escalated_by_warning_pair) {
    return "stored escalation flag disagrees with its own checks";
  }
  return null;
}

// --- Hard-rule collision (D-357/D-362) --------------------------------------
//
// A separate question from the four checks above, and deliberately not folded
// into TRANSFERABILITY_CHECKS or TransferabilityVerdict: those judge whether an
// EFFECT's claim names something a product can act on at all — "Scoped to
// EFFECTS on purpose" (transferabilityClaimOfProposal, above). This judges a
// REALIZATION's already-inferred `pattern` against constraints.hard_rules, the
// mechanism registry's own compliance boundary. Different subject (a directive,
// not a fact/boundary/title triple), different question (may this be built at
// all, not can an interface act on it), so it gets its own type and its own
// entry point rather than a fifth member of a closed, replay-critical union.
//
// Three consecutive batches (D-329, D-344, D-357) found a lever colliding with
// a mechanism's own hard_rules while every existing check — including this
// session's ANCHOR DOMAIN — read clean. This is the check that gap asked for.
// Owner-scoped (2026-08-12): checked against the hard rules of every mechanism
// in any pack the realization's own mechanism appears in, because hard rules
// are the pack's legal frame, not one mechanism's property — a pattern shipped
// under LA-01 into a paywall pack sits next to SC-06 and SC-17's rules whether
// or not LA-01's own registry record mentions them.
//
// DETERMINISTIC, matching the file's own constraint #2 above: no model call,
// replayable offline from the pattern text and the registry alone. WARNING
// ONLY, matching #3: nothing here refuses a candidate or blocks approval — it
// names a rule and lets the owner judge, because "does this cross a line" is
// the ethical call the module's own header reserves for a human throughout.
//
// MEASURED, not designed to pass a test: prototyped against the six known
// collisions (D-344's four, D-357's two) before being wired in. Plain token
// containment between a pattern and a rule's own prose catches the collision
// cleanly only when the pattern and the rule happen to share vocabulary
// (repeated-view-scarcity-nudge: 15%/11% on its own SC-06 rules, both the
// correct ones). It MISSES every collision that is behavioral rather than
// lexical — loss-first-framing and high-involvement-loss-emphasis score 0-14%
// on a run of UNRELATED mechanisms' rules and never surface panic_cap at all;
// view-count-triggered-text-suppression scores 0% on every rule in scope,
// including the accessibility_preserved rule it actually violated. That is not
// a bug to tune away — no source measured a "collision" threshold either, and
// forcing every known case to fire would mean hand-building a lexicon FROM the
// answer key. A miss here is the finding the owner asked this validation to
// produce: these rule collisions are not machine-checkable by vocabulary
// alone, at least not by this general a method.

export interface HardRuleCollisionFlag {
  mechanism_id: string;
  rule_id: string;
  rule: string;
  severity: "block" | "warn";
  /** Fraction of the rule's own distinctive tokens found in the pattern. */
  score: number;
  matched_terms: string[];
  /** The pattern's own clause with the densest overlap, for a reader to jump to. */
  pattern_clause: string | null;
}

/**
 * Fixed at this value, not tuned to the six validation cases: it sits in the
 * same low, permissive register as WEAK_ANCHOR_TOKEN_THRESHOLD (0.12,
 * lib/review-flags.ts) on the same reasoning that check states for itself —
 * the cost of a false positive here is one glance from the owner, the cost of
 * a false negative is a shipped dark pattern. Raising it would not recover any
 * of the four measured misses above; every one of them scores near zero
 * everywhere, so a stricter bar only removes true positives, not noise.
 */
export const HARD_RULE_COLLISION_TOKEN_THRESHOLD = 0.1;

function normalizeForCollisionCheck(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COLLISION_PLACEHOLDER_RE = /\{[a-z0-9_]*\}/gi;

function collisionTokens(text: string): string[] {
  return normalizeForCollisionCheck(text)
    .split(" ")
    .filter(
      (token) =>
        token.length >= 4 &&
        !OVERLAP_STOPWORDS.has(token) &&
        !GENERIC_UI_TERMS.has(token),
    );
}

/** Rough clause split, mirroring lib/review-flags.ts's own clausesOf. */
function collisionClauses(text: string): string[] {
  return text
    .split(/(?:,\s*(?:but|and|yet)\s+|;\s*|(?<=[.!?])\s+)/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

let cachedCrossCutting: { root: string; ids: Set<string> } | null = null;
function crossCuttingMechanismIds(root: string): Set<string> {
  if (cachedCrossCutting?.root === root) return cachedCrossCutting.ids;
  const dir = join(root, "registry", "mechanisms");
  const ids = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const mechanism = JSON.parse(readFileSync(join(dir, file), "utf8")) as Mechanism;
    if (mechanism.cross_cutting === true) ids.add(mechanism.id);
  }
  cachedCrossCutting = { root, ids };
  return ids;
}

/**
 * Every mechanism whose hard_rules apply to a realization anchored on
 * `mechanismId`: its own mechanism, every mechanism sharing a pack element
 * with it in packs/pack-map.yaml, and every cross_cutting mechanism — which is
 * implicitly a member of every pack element, the same rule
 * tools/extract.ts's own scope resolution already applies when a pack or
 * segment scope is requested (D-160's `crossCutting` array). A mechanism that
 * is itself cross_cutting (CL-14, IF-18, MM-15, PF-16, PS-13, SC-17) is
 * therefore checked against essentially the whole registry: it is a member of
 * every pack, so every pack's own mechanisms are its peers too.
 */
export function peerMechanismIds(mechanismId: string, root: string): string[] {
  const crossCutting = crossCuttingMechanismIds(root);
  const packMap = parseYaml(
    readFileSync(join(root, "packs", "pack-map.yaml"), "utf8"),
  ) as PackMapFile;
  const peers = new Set<string>([mechanismId, ...Array.from(crossCutting)]);
  if (crossCutting.has(mechanismId)) {
    for (const element of packMap.elements) {
      for (const id of element.mechanisms) peers.add(id);
    }
  } else {
    for (const element of packMap.elements) {
      if (!element.mechanisms.includes(mechanismId)) continue;
      for (const id of element.mechanisms) peers.add(id);
    }
  }
  return Array.from(peers).sort();
}

interface PeerHardRule {
  mechanism_id: string;
  id: string;
  rule: string;
  severity: "block" | "warn";
}

function hardRulesOfPeers(mechanismId: string, root: string): PeerHardRule[] {
  const rules: PeerHardRule[] = [];
  for (const peerId of peerMechanismIds(mechanismId, root)) {
    const path = join(root, "registry", "mechanisms", `${peerId}.json`);
    let mechanism: Mechanism;
    try {
      mechanism = JSON.parse(readFileSync(path, "utf8")) as Mechanism;
    } catch {
      // Seed-stage mechanisms (registry/mechanisms/_seed/) resolve here and
      // carry no constraints yet — nothing to check them against, not a defect.
      continue;
    }
    for (const rule of mechanism.constraints?.hard_rules ?? []) {
      rules.push({ mechanism_id: peerId, id: rule.id, rule: rule.rule, severity: rule.severity });
    }
  }
  return rules;
}

// --- Distinctiveness gate for single-token matches (D-365) ------------------
//
// MEASURED FIRST, D-364's report on 41 flags across the 28-proposal corpus: 26
// were noise, and every noise flag traced to a single shared word — "users",
// "never", "high", "displayed", "data", "must", "product", "full", "visible",
// "options", "forced", "reflect" — coincidentally present in both texts with
// no topical connection. A word that appears in many DIFFERENT hard rules
// cannot discriminate which one a pattern actually collides with; a match on
// it is closer to chance than to signal. A single-token match is now required
// to be RARE — in the corpus of every hard rule in the registry, and in the
// corpus of every inferred realization's pattern — before it may fire alone.
// Multi-token matches are exempt, unchanged: D-364 found them reliable
// (countdown/stock/timers, availability), and the owner's instruction was to
// leave what already works alone.
//
// THE THRESHOLD, AND ITS HONEST LIMIT. Calibrated to the two rules the owner
// named as non-negotiable survivors: genuine_scarcity_only's "scarcity" (1 of
// 58 rules) and panic_cap's "loss" (3 of 58 rules, the rarer of "loss" and
// "visual", both tied at 3). The rule-corpus ceiling is set at 3 rules
// (~6% of 58) — loose enough to admit both, tight enough to exclude "users"
// (4 rules) and "never" (8 rules) outright. It does NOT recover "high",
// "displayed", "data", "full", "visible", "options" or "forced": every one of
// those appears in exactly ONE hard rule, the same absolute rarity as
// "scarcity" itself. No frequency statistic computed over a 58-rule, 28-
// pattern corpus can separate a word that is rare because it is genuinely
// specific (scarcity) from a word that is rare because the corpus is small
// (high) — that distinction is about WORD SENSE, not frequency, and a
// deterministic, no-model-call check has no way to ask it. This is reported
// as a limit, not silently engineered around.
//
// The pattern-corpus leg exists for the same reason the instruction named it
// — "or most patterns" — but is close to inert on the CURRENT corpus: SC-06's
// own productive session means "scarcity" itself is the single most
// pattern-frequent word among every candidate here (4 of 28 patterns, D-364),
// higher than every named culprit. Any pattern-side ceiling tight enough to
// exclude "high"/"displayed" (3 of 28 each) would also exclude "scarcity" —
// so the ceiling is set loose (50%, literally "most" of the corpus) rather
// than tuned to a number that happens to separate today's specific words,
// which would be re-deriving the check from the answer key the owner warned
// against the first time.
export const HARD_RULE_COLLISION_RULE_RARITY_THRESHOLD = 0.06;
export const HARD_RULE_COLLISION_PATTERN_RARITY_THRESHOLD = 0.5;

let cachedRuleTokenFrequency: { root: string; total: number; freq: Map<string, number> } | null =
  null;
function ruleTokenFrequency(root: string): { total: number; freq: Map<string, number> } {
  if (cachedRuleTokenFrequency?.root === root) return cachedRuleTokenFrequency;
  const dir = join(root, "registry", "mechanisms");
  const freq = new Map<string, number>();
  let total = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const mechanism = JSON.parse(readFileSync(join(dir, file), "utf8")) as Mechanism;
    for (const rule of mechanism.constraints?.hard_rules ?? []) {
      total += 1;
      for (const token of Array.from(new Set(collisionTokens(rule.rule)))) {
        freq.set(token, (freq.get(token) ?? 0) + 1);
      }
    }
  }
  cachedRuleTokenFrequency = { root, total, freq };
  return cachedRuleTokenFrequency;
}

let cachedPatternTokenFrequency: { root: string; total: number; freq: Map<string, number> } | null =
  null;
function patternTokenFrequency(root: string): { total: number; freq: Map<string, number> } {
  if (cachedPatternTokenFrequency?.root === root) return cachedPatternTokenFrequency;
  const dir = join(root, "proposals", "realization");
  const freq = new Map<string, number>();
  let total = 0;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      let proposal: { payload?: { derivation?: string; pattern?: string } };
      try {
        proposal = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }
      const pattern = proposal.payload?.pattern;
      if (proposal.payload?.derivation !== "inferred" || typeof pattern !== "string") continue;
      total += 1;
      for (const token of Array.from(
        new Set(collisionTokens(pattern.replace(COLLISION_PLACEHOLDER_RE, " "))),
      )) {
        freq.set(token, (freq.get(token) ?? 0) + 1);
      }
    }
  }
  cachedPatternTokenFrequency = { root, total, freq };
  return cachedPatternTokenFrequency;
}

/** Whether a single shared token is rare enough to fire alone (see above). */
function isDistinctiveEnoughAlone(token: string, root: string): boolean {
  const rules = ruleTokenFrequency(root);
  const patterns = patternTokenFrequency(root);
  const ruleShare = (rules.freq.get(token) ?? 0) / rules.total;
  const patternShare = patterns.total === 0 ? 0 : (patterns.freq.get(token) ?? 0) / patterns.total;
  return (
    ruleShare <= HARD_RULE_COLLISION_RULE_RARITY_THRESHOLD &&
    patternShare <= HARD_RULE_COLLISION_PATTERN_RARITY_THRESHOLD
  );
}

/**
 * Warning-only. Never called from the approval or extraction path, and
 * nothing in lib/proposals.ts reads its output — the owner runs it (or a
 * report script that calls it) and judges. A realization with no pattern
 * (a `reported` record, or an inferred one mid-draft) returns no flags rather
 * than guessing; there is nothing to check yet.
 */
export function judgeHardRuleCollisions(
  realization: Pick<Realization, "mechanism_id" | "pattern" | "derivation">,
  root: string,
): HardRuleCollisionFlag[] {
  if (realization.derivation !== "inferred" || !realization.pattern) return [];
  const pattern = realization.pattern;
  const patternTokens = new Set(
    collisionTokens(pattern.replace(COLLISION_PLACEHOLDER_RE, " ")),
  );
  const clauses = collisionClauses(pattern);
  const flags: HardRuleCollisionFlag[] = [];
  for (const rule of hardRulesOfPeers(realization.mechanism_id, root)) {
    const ruleTokens = collisionTokens(rule.rule);
    if (ruleTokens.length === 0) continue;
    const matched = ruleTokens.filter((token) => patternTokens.has(token));
    const score = matched.length / ruleTokens.length;
    if (score < HARD_RULE_COLLISION_TOKEN_THRESHOLD) continue;
    const distinctMatched = Array.from(new Set(matched));
    if (distinctMatched.length === 1 && !isDistinctiveEnoughAlone(distinctMatched[0], root)) {
      continue;
    }
    let bestClause: string | null = null;
    let bestClauseScore = -1;
    for (const clause of clauses) {
      const clauseTokens = new Set(collisionTokens(clause));
      const overlap = matched.filter((token) => clauseTokens.has(token)).length;
      if (overlap > bestClauseScore) {
        bestClauseScore = overlap;
        bestClause = clause;
      }
    }
    flags.push({
      mechanism_id: rule.mechanism_id,
      rule_id: rule.id,
      rule: rule.rule,
      severity: rule.severity,
      score,
      matched_terms: Array.from(new Set(matched)).sort(),
      pattern_clause: bestClauseScore > 0 ? bestClause : null,
    });
  }
  return flags.sort((a, b) => b.score - a.score).slice(0, 5);
}
