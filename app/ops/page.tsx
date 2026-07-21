import Link from "next/link";
import { loadMechanismNodeIndex } from "@/lib/status";
import { isOpsWriteEnabled } from "@/lib/github";
import {
  KNOWN_CONNECTOR_IDS,
  computeBudgetSnapshot,
  defaultConnectorConfig,
  extractionPriceState,
  loadExtractionOpsConfigFromDisk,
  loadExtractionRunSummary,
  loadConnectorLastRun,
  loadOpsConnectorConfigFromDisk,
} from "@/lib/ops";
import OpsClient, {
  type ConnectorView,
  type MechanismOption,
} from "./ops-client";

export const metadata = {
  title: "Operations — Motivation Engine",
};

// Budget usage and last-run ages are computed at request time.
export const dynamic = "force-dynamic";

export default function OpsPage() {
  const writeEnabled = isOpsWriteEnabled();
  const budget = computeBudgetSnapshot();
  const extraction = loadExtractionOpsConfigFromDisk() ?? null;
  const extractionRun = loadExtractionRunSummary() ?? null;

  // Every known mechanism resolved to its L0 parent node, so the target picker
  // can group ids under node headings (motivational S1–S6 vs cross-cutting S7)
  // instead of showing one flat, unlabeled list (D-071).
  const mechanismOptions: MechanismOption[] = Array.from(
    loadMechanismNodeIndex().values(),
  )
    .map((ref) => ({
      id: ref.id,
      name: ref.name,
      parent: ref.parent,
      parentName: ref.parentName,
      crossCutting: ref.crossCutting,
    }))
    .sort(
      (a, b) => a.parent.localeCompare(b.parent) || a.id.localeCompare(b.id),
    );

  const connectors: ConnectorView[] = KNOWN_CONNECTOR_IDS.map((id) => ({
    config: loadOpsConnectorConfigFromDisk(id) ?? defaultConnectorConfig(id, []),
    lastRun: loadConnectorLastRun(id) ?? null,
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
        >
          ← control center
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
          Operations
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[#8CA495]">
          The fleet controls. Set the monthly budget, tune each connector, and start a run — the app
          never harvests itself; it triggers the GitHub workflow that does, and always shows you a
          cost estimate before anything real runs. Settings are saved as small commits to git, so
          every change is reviewable and reversible. Knowledge (the registry, dossiers, docs) stays
          read-only here and is edited in git.
        </p>
        <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">
          <Link href="/connectors" className="underline hover:text-[#34D399]">
            connectors cockpit →
          </Link>{" "}
          for the harvested corpora, health, and cost rollup.
        </p>
      </header>

      <OpsClient
        writeEnabled={writeEnabled}
        budget={budget}
        extraction={extraction}
        extractionRun={extractionRun}
        extractionPriceState={extraction ? extractionPriceState(extraction) : "unconfigured"}
        connectors={connectors}
        mechanismOptions={mechanismOptions}
      />
    </main>
  );
}
