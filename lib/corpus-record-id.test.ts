import assert from "node:assert/strict";
import test from "node:test";
import {
  assignCorpusRecordIds,
  deriveCorpusRecordId,
  normalizeCorpusDoi,
} from "./corpus-record-id";

test("normalizes DOI variants to one stable record id", () => {
  const record = { title: "Ignored", year: 2020, doi: "https://doi.org/10.1000/ABC" };
  assert.equal(normalizeCorpusDoi(record.doi), "10.1000/abc");
  assert.equal(
    deriveCorpusRecordId(record),
    deriveCorpusRecordId({ ...record, doi: "DOI:10.1000/abc", title: "Changed" }),
  );
});

test("uses normalized title and year when DOI is absent", () => {
  const first = deriveCorpusRecordId({
    doi: null,
    title: "Café—Choice: A Study",
    year: 2024,
  });
  const second = deriveCorpusRecordId({
    doi: null,
    title: "cafe choice a study",
    year: 2024,
  });
  assert.equal(first, second);
  assert.match(first, /^cr_[a-f0-9]{24}$/);
});

test("rejects duplicate logical records before writing ids", () => {
  assert.throws(
    () =>
      assignCorpusRecordIds([
        { doi: null, title: "Same", year: 2020 },
        { doi: null, title: "same", year: 2020 },
      ]),
    /must be deduplicated/,
  );
});
