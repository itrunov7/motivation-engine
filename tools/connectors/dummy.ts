/**
 * tools/connectors/dummy.ts — framework smoke test, not a real source.
 *
 * Writes 3 fake records to /corpora/_dummy/records.json. The "_"-prefixed
 * sourceId keeps it out of the showcase's corpus status computation
 * (lib/status.ts only counts dirs named after real sources.json ids).
 *
 * Pass `fail=1` to throw mid-run and exercise the failure path
 * (status "failed" manifest + non-zero exit).
 */

import type { Connector, RunQuote, RunResult } from "./types";

interface DummyRecord {
  id: string;
  title: string;
  note: string;
}

/** The 3 fake records the smoke test always writes; no network calls. */
const DUMMY_RECORD_COUNT = 3;

export const dummyConnector: Connector = {
  id: "dummy",
  sourceId: "_dummy",
  sourceIds: [],
  connectorVersion: "1.0.0",
  description: "Smoke-test connector: writes 3 fake records, no network calls.",

  /** Deterministic estimate (D-025): the smoke test makes no calls and always
   *  writes the same 3 records. */
  quote(): RunQuote {
    return { calls: 0, records: DUMMY_RECORD_COUNT, duration_s: 0, estimated_usd: 0 };
  },

  async run(ctx, params): Promise<RunResult> {
    if (params.fail === "1") {
      throw new Error("Simulated failure requested via fail=1");
    }

    const records: DummyRecord[] = [
      { id: "dummy-001", title: "Fake record one", note: "framework smoke test" },
      { id: "dummy-002", title: "Fake record two", note: "framework smoke test" },
      { id: "dummy-003", title: "Fake record three", note: "framework smoke test" },
    ];

    ctx.writeJson("records.json", records);
    ctx.log(`wrote ${records.length} fake records to records.json`);

    return {
      status: "success",
      recordsFetched: records.length,
      files: [{ path: "records.json", records: records.length }],
    };
  },
};
