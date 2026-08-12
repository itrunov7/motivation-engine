import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import type {
  Mechanism,
  PackMapFile,
  PackRealization,
  Realization,
  Taxonomy,
} from "../lib/types";
import { realizationsFor, renderRealization } from "./render-packs";

const ROOT = join(__dirname, "..");
const S8_IDS = [
  "CO-19",
  "AU-20",
  "FB-21",
  "ER-22",
  "DE-23",
  "FL-24",
  "RR-25",
  "AE-26",
];

test("S8 candidates are declared dependencies but never generated guidance", () => {
  const taxonomy = JSON.parse(
    readFileSync(join(ROOT, "registry", "taxonomy.json"), "utf-8"),
  ) as Taxonomy;
  const s8 = taxonomy.nodes.find((node) => node.id === "S8");
  assert.equal(s8?.name, "Interaction & agency");
  assert.equal(s8?.cross_cutting, false);

  const packMap = parseYaml(
    readFileSync(join(ROOT, "packs", "pack-map.yaml"), "utf-8"),
  ) as PackMapFile;
  const byId = new Map(packMap.elements.map((element) => [element.id, element]));
  assert.deepEqual(
    byId.get("core-ux")?.mechanisms.filter((id) => S8_IDS.includes(id)),
    S8_IDS,
  );
  assert.deepEqual(
    byId.get("onboarding")?.mechanisms.filter((id) => S8_IDS.includes(id)),
    ["CO-19", "AU-20", "DE-23", "FB-21", "ER-22"],
  );
  assert.deepEqual(
    byId.get("first-value")?.mechanisms.filter((id) => S8_IDS.includes(id)),
    ["CO-19", "FB-21", "DE-23", "RR-25"],
  );
  assert(byId.get("paywall-conversion")?.mechanisms.includes("DE-23"));
  assert(byId.get("retention-billing")?.mechanisms.includes("ER-22"));
  assert(!byId.get("trust-friction")?.mechanisms.includes("DE-23"));

  for (const pack of packMap.elements) {
    const generated = readFileSync(
      join(ROOT, "packs", `pack-${pack.id}.yaml`),
      "utf-8",
    );
    for (const candidateId of S8_IDS) {
      assert(
        !generated.includes(candidateId),
        `${candidateId} leaked into generated pack ${pack.id}`,
      );
    }
  }
});

// ---------- LAYER 3 projection (D-175) ----------

const inferredRealization = {
  id: "expertise-based-guidance-toggle",
  mechanism_id: "CL-14",
  effect_refs: ["cl-14-002"],
  boundary_refs: ["cl-14-001"],
  derivation: "inferred",
  domain_transfer: {
    source_domain: "educational psychology",
    application_domain: "product UI",
  },
  term: "Expertise-based guidance toggle",
  description_as_reported: "Students with no previous domain familiarity benefited from worked examples.",
  pattern:
    "Replace the guided walkthrough with an open-ended exploration mode once a user has completed the core task at least {core_task_completions_before_exploration} times.",
  parameters: [
    {
      name: "core_task_completions_before_exploration",
      value: 3,
      unit: "completions of the core task",
      evidence_basis: "none — default heuristic",
    },
  ],
  artifact_context: ["onboarding", "dashboard_widget"],
  provenance: [{ corpus_record_id: "cr_7e6bcb42220d86126199d6e2" }],
  confidence: 0.6,
} as unknown as Realization;

const reportedRealization = {
  id: "some-reported-observation",
  mechanism_id: "ZE-07",
  term: "Some reported observation",
  description_as_reported: "The interface names the supported languages.",
  artifact_context: ["landing_hero"],
  provenance: [{ corpus_record_id: "rr_d6d2a2a98095047fc3acc42a" }],
  confidence: 0.55,
} as unknown as Realization;

const mechanism = (id: string) => ({ id }) as unknown as Mechanism;

test("LAYER 3 projects the transfer, not only the description (D-175)", () => {
  const [projected] = realizationsFor(
    [mechanism("CL-14")],
    new Map([["CL-14", [inferredRealization]]]),
  );
  assert(projected);
  // The four fields the projection used to drop. Without them the generator got
  // the source's sentence and nothing built from it, while the implementations
  // section shipped twenty directives with no provenance at all.
  assert.equal(projected.derivation, "inferred");
  assert.deepEqual(projected.domain_transfer, {
    source_domain: "educational psychology",
    application_domain: "product UI",
  });
  assert(projected.pattern?.includes("{core_task_completions_before_exploration}"));
  assert.equal(projected.parameters?.length, 1);
  assert.equal(projected.parameters?.[0]?.unit, "completions of the core task");
  // What it already carried must survive unchanged.
  assert.equal(projected.effect_id, "cl-14-002");
  assert.deepEqual(projected.source_record_ids, ["cr_7e6bcb42220d86126199d6e2"]);
  // boundary_refs (D-348): carried through in FULL, unlike effect_refs -> the
  // singular effect_id above, since it is a caution list a generator should
  // see all of, not a claim needing one citation.
  assert.deepEqual(projected.boundary_refs, ["cl-14-001"]);
});

test("a reported realization declares none of the transfer keys (D-175)", () => {
  const [projected] = realizationsFor(
    [mechanism("ZE-07")],
    new Map([["ZE-07", [reportedRealization]]]),
  );
  assert(projected);
  // Absent, not undefined. parseYaml reads `derivation: undefined` back as the
  // STRING "undefined", so the renderer's re-parse self-check would pass a pack
  // asserting a derivation nobody recorded.
  for (const key of ["derivation", "domain_transfer", "pattern", "parameters", "boundary_refs"]) {
    assert.equal(key in projected, false, `${key} must be absent, not undefined`);
  }
  const emitted = renderRealization(projected).join("\n");
  for (const key of ["derivation:", "domain_transfer:", "pattern:", "parameters:", "boundary_refs:"]) {
    assert.equal(emitted.includes(key), false, `${key} must not be emitted`);
  }
});

test("an emitted realization re-parses to exactly what was projected (D-175)", () => {
  const projected = realizationsFor(
    [mechanism("CL-14")],
    new Map([["CL-14", [inferredRealization]]]),
  );
  const emitted = ["realizations:", ...renderRealization(projected[0]!)].join("\n");
  const round = parseYaml(emitted) as { realizations: PackRealization[] };
  assert.deepEqual(round.realizations[0], projected[0]);

  // The quoting is load-bearing, not incidental: a pattern that OPENS with a
  // placeholder would parse as a flow mapping if it were emitted bare.
  const leading = {
    ...inferredRealization,
    pattern: "{leading_placeholder} is shown before anything else.",
    parameters: [
      {
        name: "leading_placeholder",
        value: 1,
        unit: "elements",
        evidence_basis: "none — default heuristic",
      },
    ],
  } as unknown as Realization;
  const [leadingProjected] = realizationsFor(
    [mechanism("CL-14")],
    new Map([["CL-14", [leading]]]),
  );
  const leadingRound = parseYaml(
    ["realizations:", ...renderRealization(leadingProjected!)].join("\n"),
  ) as { realizations: PackRealization[] };
  assert.equal(
    leadingRound.realizations[0]?.pattern,
    "{leading_placeholder} is shown before anything else.",
  );
});
