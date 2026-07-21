import Link from "next/link";
import { notFound } from "next/navigation";
import { findCorpusRecord } from "@/lib/corpus";

export const dynamic = "force-static";

export default function CorpusRecordPage({
  params,
}: {
  params: { mechanism_id: string; record_id: string };
}) {
  const record = findCorpusRecord(params.mechanism_id, params.record_id);
  if (!record) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/review"
        className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
      >
        ← proposal review
      </Link>

      <header className="mt-4 border-b border-[#243329] pb-6">
        <p className="font-mono text-[11px] uppercase tracking-widest text-[#34D399]">
          Source record · {params.mechanism_id}
        </p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
          {record.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[#8CA495]">
          {record.authors.length > 0 ? record.authors.join(", ") : "Authors not recorded"}
        </p>
        <p className="mt-1 font-mono text-xs text-[#7C93A8]">
          {[record.year ?? "Year not recorded", record.venue ?? "Venue not recorded"]
            .join(" · ")}
        </p>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-[#243329] bg-[#151F1A] p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            citations
          </p>
          <p className="mt-1 text-lg text-[#E6EFE8]">{record.citations ?? "Not recorded"}</p>
        </div>
        <div className="rounded-lg border border-[#243329] bg-[#151F1A] p-4 sm:col-span-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
            categories
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {record.categories.map((category) => (
              <span
                key={category}
                className="rounded-full border border-[#243329] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[#8CA495]"
              >
                {category}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-[#243329] bg-[#151F1A] p-5">
        <h2 className="font-display text-lg text-[#E6EFE8]">Abstract</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[#8CA495]">
          {record.abstract ?? "No abstract was returned by the source API."}
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-[#243329] bg-[#151F1A] p-5">
        <h2 className="font-display text-lg text-[#E6EFE8]">Record details</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-[#7C93A8]">Record id</dt>
            <dd className="font-mono text-xs text-[#E6EFE8]">{record.record_id}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-[#7C93A8]">Source</dt>
            <dd className="text-[#E6EFE8]">{record.source_api}</dd>
          </div>
          {record.openalex_id && (
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-[#7C93A8]">OpenAlex id</dt>
              <dd className="font-mono text-xs text-[#E6EFE8]">{record.openalex_id}</dd>
            </div>
          )}
        </dl>
        {record.doi && (
          <a
            href={`https://doi.org/${record.doi}`}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex rounded-md border border-[#34D399]/40 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#34D399] hover:bg-[#1A2620]"
          >
            Open full text via DOI ↗
          </a>
        )}
      </section>
    </main>
  );
}
