import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import type { PackMapFile, Taxonomy } from "../lib/types";

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
