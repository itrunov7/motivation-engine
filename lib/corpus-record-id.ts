import { createHash } from "node:crypto";

export interface CorpusRecordIdentity {
  doi: string | null;
  title: string;
  year: number | null;
}

export const CORPUS_RECORD_ID_PATTERN = /^cr_[a-f0-9]{24}$/;

export function normalizeCorpusDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const doi = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();
  return doi.startsWith("10.") ? doi : null;
}

export function normalizeCorpusTitle(title: string): string {
  return Array.from(title.normalize("NFKD"))
    .map((character) => {
      if (/[\u0300-\u036f]/.test(character)) return "";
      if (/[0-9]/.test(character)) return character;
      if (character.toLowerCase() !== character.toUpperCase()) {
        return character.toLowerCase();
      }
      const point = character.codePointAt(0) ?? 0;
      const unicodePunctuation =
        (point >= 0x2000 && point <= 0x206f) ||
        (point >= 0x2e00 && point <= 0x2e7f) ||
        (point >= 0x3000 && point <= 0x303f) ||
        (point >= 0xfe10 && point <= 0xfe1f) ||
        (point >= 0xfe30 && point <= 0xfe4f) ||
        (point >= 0xff00 && point <= 0xff65);
      return point > 0x7f && !unicodePunctuation ? character.toLowerCase() : " ";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function corpusRecordIdentity(record: CorpusRecordIdentity): string {
  const doi = normalizeCorpusDoi(record.doi);
  if (doi) return `doi:${doi}`;
  const title = normalizeCorpusTitle(record.title);
  if (!title) throw new Error("Cannot derive corpus record id from an empty title");
  return `title-year:${title}:${record.year ?? "undated"}`;
}

export function deriveCorpusRecordId(record: CorpusRecordIdentity): string {
  const digest = createHash("sha256")
    .update(corpusRecordIdentity(record), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `cr_${digest}`;
}

export function assignCorpusRecordIds<T extends CorpusRecordIdentity>(
  records: readonly T[],
): Array<T & { record_id: string }> {
  const identities = new Map<string, string>();
  return records.map((record) => {
    const recordId = deriveCorpusRecordId(record);
    const identity = corpusRecordIdentity(record);
    const previous = identities.get(recordId);
    if (previous && previous !== identity) {
      throw new Error(`Corpus record id collision for ${recordId}`);
    }
    if (previous === identity) {
      throw new Error(
        `Duplicate corpus identity "${identity}" must be deduplicated before assigning ids`,
      );
    }
    identities.set(recordId, identity);
    return { ...record, record_id: recordId };
  });
}
