/**
 * Recovery/debugging caller for the shared proposal approval library.
 * The primary owner path is /review; this CLI is intentionally thin.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyLocalTransaction,
  LocalRepositorySnapshot,
} from "../lib/local-transaction";
import {
  prepareProposalDecision,
  PROPOSAL_TYPES,
  type ProposalDecisionRequest,
} from "../lib/proposals";

const ROOT = join(__dirname, "..");

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function usage(): never {
  console.error(
    "Usage:\n" +
      "  npm run proposal -- list\n" +
      "  npm run proposal -- show proposals/{type}/{id}.json\n" +
      "  npm run proposal -- approve|reject proposals/{type}/{id}.json [--actor=owner] [--reason=text]\n" +
      "  npm run proposal -- edit proposals/{type}/{id}.json --payload-json='{...}' [--confidence=0.55] [--actor=owner]",
  );
  process.exit(1);
}

function proposalPaths(): string[] {
  return PROPOSAL_TYPES.flatMap((type) => {
    const directory = join(ROOT, "proposals", type);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => `proposals/${type}/${name}`);
  }).sort();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "list") {
    for (const path of proposalPaths()) {
      const proposal = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as {
        id: string;
        type: string;
        target: string;
        status: string;
      };
      console.log(`${proposal.status.padEnd(8)} ${proposal.type.padEnd(16)} ${proposal.id} → ${proposal.target}`);
    }
    if (proposalPaths().length === 0) console.log("No proposals.");
    return;
  }

  const proposalPath = process.argv[3];
  if (command === "show" && proposalPath) {
    process.stdout.write(readFileSync(join(ROOT, proposalPath), "utf8"));
    return;
  }
  if (
    !proposalPath ||
    (command !== "approve" && command !== "reject" && command !== "edit")
  ) {
    usage();
  }

  let editedPayload: unknown;
  if (command === "edit") {
    const payloadJson = option("payload-json");
    if (!payloadJson) usage();
    editedPayload = JSON.parse(payloadJson);
  }
  const rawConfidence = option("confidence");
  if (rawConfidence !== undefined && command !== "edit") usage();
  const request: ProposalDecisionRequest = {
    proposalPath,
    action: command,
    decidedBy: option("actor") ?? process.env.REVIEW_DECIDED_BY ?? "owner",
    decidedAt: new Date().toISOString(),
    reason: option("reason"),
    editedPayload,
    ...(rawConfidence === undefined ? {} : { editedConfidence: Number(rawConfidence) }),
    schemaRoot: ROOT,
  };
  const transaction = await prepareProposalDecision(
    new LocalRepositorySnapshot(ROOT),
    request,
  );
  await applyLocalTransaction(ROOT, transaction);
  console.log(
    `${command} ${transaction.proposalType}/${transaction.proposalId}; ${transaction.mutations.length} files changed; decision ${transaction.decisionId}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
