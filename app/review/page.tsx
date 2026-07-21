import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import {
  getRepoFile,
  listRepoDirectory,
  readGithubOpsEnv,
} from "@/lib/github";
import { PROPOSAL_TYPES } from "@/lib/proposals";
import type { Proposal } from "@/lib/types";
import ReviewClient, { type ReviewProposal } from "./review-client";

export const metadata = {
  title: "Proposal Review — Motivation Engine",
};

export const dynamic = "force-dynamic";

function localProposals(): ReviewProposal[] {
  const root = join(process.cwd(), "proposals");
  if (!existsSync(root)) return [];
  return PROPOSAL_TYPES.flatMap((type) => {
    const directory = join(root, type);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const path = `proposals/${type}/${name}`;
        return {
          path,
          proposal: JSON.parse(readFileSync(join(directory, name), "utf8")) as Proposal,
        };
      });
  });
}

async function liveProposals(): Promise<{
  proposals: ReviewProposal[];
  writeEnabled: boolean;
  error: string | null;
}> {
  const env = readGithubOpsEnv();
  if (!env) {
    return { proposals: localProposals(), writeEnabled: false, error: null };
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
    const files = await Promise.all(paths.map((path) => getRepoFile(env, path)));
    return {
      proposals: files.flatMap((file, index) =>
        file
          ? [
              {
                path: paths[index],
                proposal: JSON.parse(file.text) as Proposal,
              },
            ]
          : [],
      ),
      writeEnabled: true,
      error: null,
    };
  } catch (error) {
    return {
      proposals: localProposals(),
      writeEnabled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default async function ReviewPage() {
  const { proposals, writeEnabled, error } = await liveProposals();
  const ordered = [...proposals].sort(
    (left, right) =>
      Number(right.proposal.status === "pending" || right.proposal.status === "edited") -
        Number(left.proposal.status === "pending" || left.proposal.status === "edited") ||
      right.proposal.proposed_at.localeCompare(left.proposal.proposed_at),
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
        >
          ← control center
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
              Proposal review
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[#8CA495]">
              The only path from extracted claims to authoritative knowledge.
              Approval validates the proposal and resulting artifact, then commits
              the artifact, proposal status, and decision trail together.
            </p>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            {ordered.length} proposal{ordered.length === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {!writeEnabled && (
        <div className="mt-6 rounded-lg border border-[#E4B54E]/30 bg-[#151F1A] p-4 text-sm text-[#8CA495]">
          Review is read-only. Configure GH_OPS_TOKEN and GH_OPS_REPO to approve
          from the Control Center.
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-[#F87171]/30 bg-[#151F1A] p-4 text-sm text-[#F87171]">
          Live GitHub proposals could not be loaded: {error}. Showing the deployed
          repository snapshot.
        </div>
      )}

      {ordered.length === 0 ? (
        <section className="mt-8 rounded-lg border border-dashed border-[#243329] bg-[#151F1A] p-8 text-center">
          <h2 className="font-display text-lg text-[#E6EFE8]">No proposals yet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-[#8CA495]">
            Grounded extraction runs will write files to{" "}
            <code className="font-mono text-[#34D399]">
              proposals/{"{type}"}/{"{id}"}.json
            </code>
            . They appear here after the workflow commits them and remain
            non-authoritative until the owner approves.
          </p>
        </section>
      ) : (
        <ReviewClient proposals={ordered} />
      )}
    </main>
  );
}
