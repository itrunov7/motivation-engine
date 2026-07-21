import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RealizationCorpusFile,
  RealizationCorpusProvenanceItem,
  RealizationCorpusRecord,
} from "./types";

export const REALIZATION_RECORD_ID_PATTERN = /^rr_[a-f0-9]{24}$/;
const MECHANISM_ID_PATTERN = /^[A-Z]{2}-\d{2}$/;

export function deriveRealizationRecordId(input: {
  mechanism_id: string;
  source_id: string;
  source_locator: string;
  observation: string;
}): string {
  const identity = [
    input.mechanism_id,
    input.source_id.trim().toLowerCase(),
    input.source_locator.trim(),
    input.observation.normalize("NFKC").replace(/\s+/g, " ").trim(),
  ].join("\u0000");
  return `rr_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}`;
}

export function loadRealizationCorpus(mechanismId: string): RealizationCorpusFile | null {
  if (!MECHANISM_ID_PATTERN.test(mechanismId)) return null;
  const path = join(
    process.cwd(),
    "corpora",
    "realizations",
    mechanismId,
    "records.json",
  );
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RealizationCorpusFile;
}

export function findRealizationCorpusRecord(
  mechanismId: string,
  recordId: string,
): RealizationCorpusRecord | null {
  if (!REALIZATION_RECORD_ID_PATTERN.test(recordId)) return null;
  return (
    loadRealizationCorpus(mechanismId)?.records.find(
      (record) => record.record_id === recordId,
    ) ?? null
  );
}

export function isRealizationProvenance(
  item: { corpus_kind?: string },
): item is RealizationCorpusProvenanceItem {
  return item.corpus_kind === "realization";
}
