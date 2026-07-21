import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { getRepoFile, listRepoDirectory, readGithubOpsEnv, type GithubOpsEnv } from "@/lib/github";
import {
  isActionableProposal,
  prepareProposalPreview,
  PROPOSAL_TYPES,
  type RepositorySnapshot,
} from "@/lib/proposals";
import type { Proposal, ProposalType } from "@/lib/types";
import { loadFullMechanisms, loadSources } from "@/lib/data";
import ReviewClient, { type ReviewProposal } from "./review-client";

export const metadata = { title: "Proposal Review — Motivation Engine" };
export const dynamic = "force-dynamic";

class LocalSnapshot implements RepositorySnapshot {
  async read(path: string): Promise<string | null> {
    const file = join(process.cwd(), path);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }
}

class GithubSnapshot implements RepositorySnapshot {
  constructor(private readonly env: GithubOpsEnv) {}
  async read(path: string): Promise<string | null> {
    return (await getRepoFile(this.env, path))?.text ?? null;
  }
}

function localProposalPaths(): string[] {
  const root = join(process.cwd(), "proposals");
  if (!existsSync(root)) return [];
  return PROPOSAL_TYPES.flatMap((type) => {
    const directory = join(root, type);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => `proposals/${type}/${name}`);
  });
}

async function enrich(
  snapshot: RepositorySnapshot,
  paths: string[],
): Promise<ReviewProposal[]> {
  return Promise.all(
    paths.map(async (path) => {
      const text = await snapshot.read(path);
      if (!text) throw new Error(`Proposal disappeared while loading: ${path}`);
      const proposal = JSON.parse(text) as Proposal;
      if (
        !isActionableProposal(proposal) &&
        !(proposal.status === "held_low_confidence" && proposal.operation === "enrich")
      ) {
        return { path, proposal, preview: [] };
      }
      try {
        const preview = await prepareProposalPreview(snapshot, path);
        return {
          path,
          proposal,
          preview: preview.map((mutation) => ({
            path: mutation.path,
            before: mutation.expectedContent,
            after: mutation.content,
          })),
        };
      } catch (previewError) {
        return {
          path,
          proposal,
          preview: [],
          previewError:
            previewError instanceof Error ? previewError.message : String(previewError),
        };
      }
    }),
  );
}

async function loadQueue(): Promise<{
  proposals: ReviewProposal[];
  writeEnabled: boolean;
  error: string | null;
}> {
  const env = readGithubOpsEnv();
  if (!env) {
    const snapshot = new LocalSnapshot();
    return {
      proposals: await enrich(snapshot, localProposalPaths()),
      writeEnabled: false,
      error: null,
    };
  }
  try {
    const directories = await Promise.all(
      PROPOSAL_TYPES.map((type) => listRepoDirectory(env, `proposals/${type}`)),
    );
    const paths = directories
      .flat()
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".json"))
      .map((entry) => entry.path)
      .sort();
    return {
      proposals: await enrich(new GithubSnapshot(env), paths),
      writeEnabled: true,
      error: null,
    };
  } catch (loadError) {
    const snapshot = new LocalSnapshot();
    return {
      proposals: await enrich(snapshot, localProposalPaths()),
      writeEnabled: false,
      error: loadError instanceof Error ? loadError.message : String(loadError),
    };
  }
}

type ConfidenceFilter = "high" | "medium" | "low";
function confidenceMatches(value: number, filter?: string): boolean {
  if (filter === "high") return value >= 0.8;
  if (filter === "medium") return value >= 0.5 && value < 0.8;
  if (filter === "low") return value < 0.5;
  return true;
}

function filterHref(
  current: { type?: string; target?: string; confidence?: string },
  key: "type" | "target" | "confidence",
  value: string,
): string {
  const params = new URLSearchParams();
  for (const [name, selected] of Object.entries(current)) {
    if (selected && name !== key) params.set(name, selected);
  }
  if (current[key] !== value) params.set(key, value);
  const query = params.toString();
  return query ? `/review?${query}` : "/review";
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams?: { type?: string; target?: string; confidence?: string };
}) {
  const { proposals, writeEnabled, error } = await loadQueue();
  const mechanisms = loadFullMechanisms()
    .map((mechanism) => ({ id: mechanism.id, name: mechanism.name }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const manualSources = loadSources()
    .classes.flatMap((sourceClass) => sourceClass.sources)
    .filter(
      (source) =>
        source.connection_mode === "manual" && source.feeds.includes("L3"),
    )
    .map((source) => ({
      id: source.id,
      name: source.name,
      legalNote: source.legal_note ?? "Manual source; human curation only",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const filters = searchParams ?? {};
  const validType = PROPOSAL_TYPES.includes(filters.type as ProposalType)
    ? filters.type
    : undefined;
  const validConfidence = (["high", "medium", "low"] as ConfidenceFilter[]).includes(
    filters.confidence as ConfidenceFilter,
  )
    ? filters.confidence
    : undefined;
  const targets = Array.from(new Set(proposals.map((item) => item.proposal.target))).sort();
  const ordered = proposals
    .filter(
      (item) =>
        (!validType || item.proposal.type === validType) &&
        (!filters.target || item.proposal.target === filters.target) &&
        confidenceMatches(item.proposal.confidence, validConfidence),
    )
    .sort(
      (left, right) =>
        Number(isActionableProposal(right.proposal)) -
          Number(isActionableProposal(left.proposal)) ||
        left.proposal.type.localeCompare(right.proposal.type) ||
        left.proposal.target.localeCompare(right.proposal.target) ||
        right.proposal.proposed_at.localeCompare(left.proposal.proposed_at),
    );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header>
        <Link href="/" className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]">
          ← control center
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">Proposal review</h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[#8CA495]">
              Check the proposed change against its source, then approve or reject it.
              Nothing enters the knowledge layer before this review.
            </p>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            {ordered.length} of {proposals.length} shown
          </span>
        </div>
      </header>

      {!writeEnabled && (
        <div className="mt-6 rounded-lg border border-[#E4B54E]/30 bg-[#151F1A] p-4 text-sm text-[#8CA495]">
          Review is read-only. Configure GH_OPS_TOKEN and GH_OPS_REPO to make decisions here.
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-[#F87171]/30 bg-[#151F1A] p-4 text-sm text-[#F87171]">
          Live proposals could not be loaded: {error}. Showing the deployed snapshot.
        </div>
      )}

      <section className="mt-6 space-y-3 rounded-lg border border-[#243329] bg-[#151F1A] p-4">
        {[
          { key: "type" as const, label: "Kind", values: PROPOSAL_TYPES },
          { key: "target" as const, label: "Target", values: targets },
          { key: "confidence" as const, label: "Confidence", values: ["high", "medium", "low"] },
        ].map((group) => (
          <div key={group.key} className="flex flex-wrap items-center gap-2">
            <span className="w-24 font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">{group.label}</span>
            {group.values.map((value) => (
              <Link
                key={value}
                href={filterHref(filters, group.key, value)}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
                  filters[group.key] === value
                    ? "border-[#34D399]/60 text-[#34D399]"
                    : "border-[#243329] text-[#8CA495] hover:text-[#E6EFE8]"
                }`}
              >
                {value.replaceAll("_", " ")}
              </Link>
            ))}
          </div>
        ))}
      </section>

      <ReviewClient
        proposals={ordered}
        writeEnabled={writeEnabled}
        mechanisms={mechanisms}
        manualSources={manualSources}
      />

      {ordered.length === 0 ? (
        <section className="mt-8 rounded-lg border border-dashed border-[#243329] bg-[#151F1A] p-8 text-center">
          <h2 className="font-display text-lg text-[#E6EFE8]">
            {proposals.length === 0 ? "No proposals yet" : "Nothing matches these filters"}
          </h2>
          <p className="mt-2 text-sm text-[#8CA495]">
            {proposals.length === 0
              ? "Grounded extraction will place review items in proposals/{type}/{id}.json."
              : "Clear a filter to see the rest of the queue."}
          </p>
        </section>
      ) : null}
    </main>
  );
}
