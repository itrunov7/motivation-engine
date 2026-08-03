"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import {
  commitGitDataTransaction,
  dispatchExtraction,
  getRepoFile,
  GithubTransactionConflictError,
  readGithubOpsEnv,
  type GithubOpsEnv,
} from "@/lib/github";
import {
  BatchProposalValidationError,
  prepareBatchProposalDecision,
  prepareOwnerObservationTransaction,
  prepareProposalDecision,
  type ProposalDecisionRequest,
  type RepositorySnapshot,
} from "@/lib/proposals";

export type ReviewActionResult =
  | { ok: true; decisionId: string; proposalIds?: string[] }
  | {
      ok: false;
      error: string;
      reports?: { proposalPath: string; proposalId: string | null; error?: string }[];
    };

export type OwnerObservationResult =
  | { ok: true; recordId: string; extractionDispatched: boolean; warning?: string }
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
    revalidatePath("/");
    revalidatePath("/decisions");
    return { ok: true, decisionId: transaction.decisionId };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GithubTransactionConflictError
          ? "The repository changed while this decision was being prepared. Refresh and try again."
          : error instanceof Error
            ? error.message
            : String(error),
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

export async function editThenApproveProposalAction(
  proposalPath: string,
  payloadJson: string,
  note?: string,
): Promise<ReviewActionResult> {
  const reason = note?.trim();
  if (!reason) {
    return {
      ok: false,
      error: "A non-empty reason is required to narrow a proposal.",
    };
  }
  let editedPayload: unknown;
  try {
    editedPayload = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `Payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return runDecision({
    proposalPath,
    action: "edit_approve",
    editedPayload,
    reason,
  });
}

export async function batchProposalAction(
  proposalPaths: string[],
  action: "approve" | "reject",
  reason?: string,
): Promise<ReviewActionResult> {
  try {
    await requireOwner();
    const env = readGithubOpsEnv();
    if (!env) {
      throw new Error(
        "Review writes are disabled — set GH_OPS_TOKEN and GH_OPS_REPO.",
      );
    }
    const transaction = await prepareBatchProposalDecision(
      new GithubRepositorySnapshot(env),
      {
        proposalPaths,
        action,
        reason,
        decidedBy: process.env.REVIEW_DECIDED_BY ?? "owner",
        decidedAt: new Date().toISOString(),
      },
    );
    await commitGitDataTransaction(env, transaction);
    revalidatePath("/review");
    revalidatePath("/");
    revalidatePath("/decisions");
    return {
      ok: true,
      decisionId: transaction.decisionId,
      proposalIds: transaction.proposalIds,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GithubTransactionConflictError
          ? "The repository changed while this batch was being prepared. Refresh and try again."
          : error instanceof Error
            ? error.message
            : String(error),
      ...(error instanceof BatchProposalValidationError
        ? {
            reports: error.reports.map((report) => ({
              proposalPath: report.proposalPath,
              proposalId: report.proposalId,
              error: report.error,
            })),
          }
        : {}),
    };
  }
}

export async function submitOwnerObservationAction(input: {
  mechanismId: string;
  sourceId: string;
  sourceUrl: string;
  sourceLocator: string;
  observation: string;
  artifactContext: string[];
  observedAt: string;
  attested: boolean;
}): Promise<OwnerObservationResult> {
  try {
    await requireOwner();
    const env = readGithubOpsEnv();
    if (!env) {
      throw new Error(
        "Review writes are disabled — set GH_OPS_TOKEN and GH_OPS_REPO.",
      );
    }
    const transaction = await prepareOwnerObservationTransaction(
      new GithubRepositorySnapshot(env),
      {
        ...input,
        contributedBy: process.env.REVIEW_DECIDED_BY ?? "owner",
        submittedAt: new Date().toISOString(),
      },
    );
    await commitGitDataTransaction(env, transaction);
    let warning: string | undefined;
    try {
      await dispatchExtraction(env, {
        mode: "realizations",
        scope_kind: "mechanism",
        scope_id: input.mechanismId,
        dry_run: "false",
      });
    } catch (dispatchError) {
      warning =
        "Observation was committed, but extraction dispatch failed: " +
        (dispatchError instanceof Error ? dispatchError.message : String(dispatchError));
    }
    revalidatePath("/review");
    return {
      ok: true,
      recordId: transaction.recordId,
      extractionDispatched: warning === undefined,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GithubTransactionConflictError
          ? "The repository changed while this observation was prepared. Refresh and try again."
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}
