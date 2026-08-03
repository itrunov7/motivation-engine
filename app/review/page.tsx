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
import { computeProposalFlags } from "@/lib/review-flags";
import { buildSourceContext } from "@/lib/source-context";
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

/** A proposal (or a whole proposal-type directory) that could not be read or
 * parsed. Reported to the owner instead of thrown — see BrokenProposals. */
export interface BrokenProposal {
  path: string;
  error: string;
}

/**
 * Lists every proposals/{type}/*.json path, one readdirSync per type,
 * EACH GUARDED SEPARATELY (D-148): a directory-scan failure for one type
 * (a transient EMFILE under load, a permissions error) must not discard the
 * other six types' proposals, and must not throw past this function — it is
 * reported as a BrokenProposal instead, so the owner sees exactly what could
 * not be listed and why, rather than a blank or crashed /review.
 */
function localProposalPaths(): { paths: string[]; errors: BrokenProposal[] } {
  const root = join(process.cwd(), "proposals");
  if (!existsSync(root)) return { paths: [], errors: [] };
  const errors: BrokenProposal[] = [];
  const paths = PROPOSAL_TYPES.flatMap((type) => {
    const directory = join(root, type);
    try {
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => `proposals/${type}/${name}`);
    } catch (error) {
      errors.push({
        path: `proposals/${type}`,
        error: `Could not list ${type} proposals: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return [];
    }
  });
  return { paths, errors };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once.
 *
 * D-148: /review used an unbounded Promise.all over every proposal path —
 * up to ~230 on this queue — and each enrichment can itself trigger several
 * more synchronous directory scans (computeProposalFlags' triage checks
 * re-scan proposals/effect and realizations/{mechanism} per item). Vercel's
 * production incident (digest 2259791759) was exactly this: EMFILE, too
 * many open files, scanning proposals/effect — the queue's own size,
 * fanned out with no ceiling, exhausted the runtime's file descriptors.
 * Bounding concurrency here keeps peak simultaneous file/network handles
 * proportional to `limit`, not to the queue size.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

const ENRICH_CONCURRENCY = 8;

/**
 * Triage flags and source context are advisory (rule: "flags advise, they
 * never block Accept") and read from disk independently of the proposal
 * itself (computeProposalFlags re-scans realizations/effects for the
 * DUPLICATE/WEAK ANCHOR checks). A failure here — including a transient
 * EMFILE — must degrade to "no flags, no resolved context" rather than
 * take down the whole card: the proposal is still exactly as reviewable
 * without them, just without a second opinion this render.
 */
function attachReviewAids(proposal: Proposal): Pick<
  ReviewProposal,
  "flags" | "sourceContexts"
> {
  let flags: ReviewProposal["flags"] = [];
  try {
    flags = computeProposalFlags(proposal);
  } catch {
    flags = [];
  }
  const sourceContexts = proposal.provenance.map((item) => {
    try {
      return buildSourceContext(item);
    } catch {
      return null;
    }
  });
  return { flags, sourceContexts };
}

/**
 * Enriches every proposal path with bounded concurrency (D-148) and full
 * per-item isolation: a proposal that cannot be read, parsed, or enriched
 * is reported as a BrokenProposal and excluded from the reviewable list,
 * but it can never fail the OTHERS — /review must stay readable for every
 * well-formed proposal even when one record on disk is malformed or a
 * transient I/O error hits mid-render.
 */
async function enrich(
  snapshot: RepositorySnapshot,
  paths: string[],
): Promise<{ proposals: ReviewProposal[]; broken: BrokenProposal[] }> {
  const proposals: ReviewProposal[] = [];
  const broken: BrokenProposal[] = [];
  await forEachWithConcurrency(paths, ENRICH_CONCURRENCY, async (path) => {
    try {
      const text = await snapshot.read(path);
      if (!text) throw new Error(`Proposal disappeared while loading: ${path}`);
      const proposal = JSON.parse(text) as Proposal;
      const aids = attachReviewAids(proposal);
      if (
        !isActionableProposal(proposal) &&
        !(proposal.status === "held_low_confidence" && proposal.operation === "enrich")
      ) {
        proposals.push({ path, proposal, preview: [], ...aids });
        return;
      }
      try {
        const preview = await prepareProposalPreview(snapshot, path);
        proposals.push({
          path,
          proposal,
          preview: preview.map((mutation) => ({
            path: mutation.path,
            before: mutation.expectedContent,
            after: mutation.content,
          })),
          ...aids,
        });
      } catch (previewError) {
        proposals.push({
          path,
          proposal,
          preview: [],
          previewError:
            previewError instanceof Error ? previewError.message : String(previewError),
          ...aids,
        });
      }
    } catch (error) {
      broken.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { proposals, broken };
}

async function loadQueue(): Promise<{
  proposals: ReviewProposal[];
  broken: BrokenProposal[];
  writeEnabled: boolean;
  error: string | null;
}> {
  const env = readGithubOpsEnv();
  if (!env) {
    const snapshot = new LocalSnapshot();
    const { paths, errors } = localProposalPaths();
    const { proposals, broken } = await enrich(snapshot, paths);
    return {
      proposals,
      broken: [...errors, ...broken],
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
    const { proposals, broken } = await enrich(new GithubSnapshot(env), paths);
    return {
      proposals,
      broken,
      writeEnabled: true,
      error: null,
    };
  } catch (loadError) {
    const snapshot = new LocalSnapshot();
    const { paths, errors } = localProposalPaths();
    const { proposals, broken } = await enrich(snapshot, paths);
    return {
      proposals,
      broken: [...errors, ...broken],
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
  const { proposals, broken, writeEnabled, error } = await loadQueue();
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
        Number(right.flags.length > 0) - Number(left.flags.length > 0) ||
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
      {broken.length > 0 && (
        <div className="mt-4 rounded-lg border border-[#F87171]/30 bg-[#151F1A] p-4 text-sm text-[#F87171]">
          <p>
            {broken.length} proposal{broken.length === 1 ? "" : "s"} could not be read or
            parsed and {broken.length === 1 ? "is" : "are"} excluded from the queue below —
            everything else still loaded normally.
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {broken.map((item) => (
              <li key={item.path}>
                {item.path}: {item.error}
              </li>
            ))}
          </ul>
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
