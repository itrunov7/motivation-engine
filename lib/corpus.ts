import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceCorpusFile, EvidenceCorpusRecord } from "./types";
import type { RealizationCorpusRecord } from "./types";
import {
  findRealizationCorpusRecord,
  REALIZATION_RECORD_ID_PATTERN,
} from "./realization-corpus";

const MECHANISM_ID = /^[A-Z]{2}-\d{2}$/;
const RECORD_ID = /^cr_[a-f0-9]{24}$/;

export function loadEvidenceCorpus(mechanismId: string): EvidenceCorpusFile | null {
  if (!MECHANISM_ID.test(mechanismId)) return null;
  const path = join(process.cwd(), "corpora", "evidence", `${mechanismId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as EvidenceCorpusFile;
}

export function findCorpusRecord(
  mechanismId: string,
  recordId: string,
): EvidenceCorpusRecord | RealizationCorpusRecord | null {
  if (REALIZATION_RECORD_ID_PATTERN.test(recordId)) {
    return findRealizationCorpusRecord(mechanismId, recordId);
  }
  if (!RECORD_ID.test(recordId)) return null;
  return (
    loadEvidenceCorpus(mechanismId)?.records.find(
      (record) => record.record_id === recordId,
    ) ?? null
  );
}
