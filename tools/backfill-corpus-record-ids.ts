import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignCorpusRecordIds } from "../lib/corpus-record-id";
import type { EvidenceCorpusFile, EvidenceCorpusRecord } from "../lib/types";

const evidenceDir = join(process.cwd(), "corpora", "evidence");
let changed = 0;
let records = 0;

for (const name of readdirSync(evidenceDir).sort()) {
  if (!name.endsWith(".json") || name === "manifest.json") continue;
  const path = join(evidenceDir, name);
  const original = readFileSync(path, "utf8");
  const corpus = JSON.parse(original) as EvidenceCorpusFile;
  if (!Array.isArray(corpus.records)) continue;

  const withoutIds = corpus.records.map(({ record_id: _recordId, ...record }) => record);
  const nextRecords = assignCorpusRecordIds(
    withoutIds as Omit<EvidenceCorpusRecord, "record_id">[],
  );
  const next = `${JSON.stringify({ ...corpus, records: nextRecords }, null, 2)}\n`;
  records += nextRecords.length;
  if (next !== original) {
    writeFileSync(path, next);
    changed++;
    console.log(`  ✓ ${name}: ${nextRecords.length} stable ids`);
  }
}

console.log(`Backfill complete: ${records} records, ${changed} files changed.`);
