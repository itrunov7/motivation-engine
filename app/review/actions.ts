"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import {
  commitGitDataTransaction,
  getRepoFile,
  readGithubOpsEnv,
  type GithubOpsEnv,
} from "@/lib/github";
import {
  prepareProposalDecision,
  type ProposalDecisionRequest,
  type RepositorySnapshot,
} from "@/lib/proposals";

export type ReviewActionResult =
  | { ok: true; decisionId: string }
  | { ok: false; error: string };

class GithubRepositorySnapshot implements RepositorySnapshot {
  constructor(private readonly env: GithubOpsEnv) {}

  async read(path: string): Promise<string | null> {
    return (await getRepoFile(this.env, path))?.text ?? null;
  }
}

async function requireOwner(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    throw new Error("Your session is not authenticated.");
  }
}

async function runDecision(
  request: Omit<ProposalDecisionRequest, "decidedBy" | "decidedAt">,
): Promise<ReviewActionResult> {
  try {
    await requireOwner();
    const env = readGithubOpsEnv();
    if (!env) {
      throw new Error(
        "Review writes are disabled — set GH_OPS_TOKEN and GH_OPS_REPO.",
      );
    }
    const transaction = await prepareProposalDecision(
      new GithubRepositorySnapshot(env),
      {
        ...request,
        decidedBy: process.env.REVIEW_DECIDED_BY ?? "owner",
        decidedAt: new Date().toISOString(),
      },
    );
    await commitGitDataTransaction(env, transaction);
    revalidatePath("/review");
    return { ok: true, decisionId: transaction.decisionId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function approveProposalAction(
  proposalPath: string,
  note?: string,
): Promise<ReviewActionResult> {
  return runDecision({
    proposalPath,
    action: "approve",
    reason: note?.trim() || undefined,
  });
}

export async function rejectProposalAction(
  proposalPath: string,
  reason: string,
): Promise<ReviewActionResult> {
  return runDecision({ proposalPath, action: "reject", reason });
}

export async function editProposalAction(
  proposalPath: string,
  payloadJson: string,
): Promise<ReviewActionResult> {
  let editedPayload: unknown;
  try {
    editedPayload = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `Payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return runDecision({ proposalPath, action: "edit", editedPayload });
}
