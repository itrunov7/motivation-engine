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
import {
  TRANSFERABILITY_CHECKS,
  type Effect,
  type Proposal,
  type TransferabilityCheck,
  type TransferabilityCheckResult,
  type TransferabilityVerdict,
} from "./types";

/**
 * Bump on any rule change, and record the change as a decision. A stored
 * verdict is only interpretable next to the rules that produced it, and
 * "the lexicon quietly grew a word" is precisely the drift this number exists
 * to make visible.
 */
export const TRANSFERABILITY_RULESET_VERSION = 1;

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

  const refused = checks.some((result) => result.outcome === "fail");
  const warnings = checks.filter((result) => result.outcome === "warn");
  const escalated = !refused && warnings.length >= 2;

  return {
    ruleset_version: TRANSFERABILITY_RULESET_VERSION,
    transferable: !refused && !escalated,
    checks,
    escalated_by_warning_pair: escalated,
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
