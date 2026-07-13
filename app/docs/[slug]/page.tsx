import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DOC_SLUGS, listDocs, loadDoc } from "@/lib/data";

export function generateStaticParams() {
  return DOC_SLUGS.map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const doc = loadDoc(params.slug);
  return {
    title: doc
      ? `${doc.title} — Motivation Engine`
      : "Docs — Motivation Engine",
  };
}

export default function DocPage({ params }: { params: { slug: string } }) {
  const doc = loadDoc(params.slug);
  if (!doc) notFound();
  const docs = listDocs();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header>
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
        >
          ← control center
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
          Docs — the library
        </h1>
        <p className="mt-1 text-sm text-[#8CA495]">
          The five foundation documents, rendered from /docs/*.md. Written by
          the owner; the showcase renders them, never edits them.
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-6 lg:flex-row">
        <nav className="shrink-0 lg:w-64">
          <p className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            documents · {docs.length}
          </p>
          <ul className="mt-3 flex flex-col gap-1">
            {docs.map((entry) => {
              const active = entry.slug === doc.slug;
              return (
                <li key={entry.slug}>
                  <Link
                    href={`/docs/${entry.slug}`}
                    className={
                      active
                        ? "block rounded-md border border-[#34D399]/40 bg-[#1A2620] px-3 py-2 text-sm text-[#34D399]"
                        : "block rounded-md border border-transparent px-3 py-2 text-sm text-[#8CA495] hover:border-[#243329] hover:bg-[#151F1A] hover:text-[#E6EFE8]"
                    }
                  >
                    <span className="font-mono text-[11px] text-[#7C93A8]">
                      {entry.slug}
                    </span>
                    <span className="mt-0.5 block leading-snug">
                      {entry.title}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <article className="min-w-0 flex-1 rounded-lg border border-[#243329] bg-[#151F1A] p-6 sm:p-8">
          <div
            className="
              text-sm leading-relaxed text-[#8CA495]
              [&_h1]:font-display [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-[#E6EFE8]
              [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-medium [&_h2]:text-[#E6EFE8]
              [&_h3]:mt-6 [&_h3]:font-display [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#E6EFE8]
              [&_h4]:mt-4 [&_h4]:font-mono [&_h4]:text-xs [&_h4]:uppercase [&_h4]:tracking-widest [&_h4]:text-[#7C93A8]
              [&_p]:mt-3
              [&_strong]:text-[#E6EFE8]
              [&_em]:text-[#E6EFE8]
              [&_a]:text-[#34D399] [&_a]:underline [&_a]:underline-offset-2
              [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:marker:text-[#7C93A8]
              [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:marker:text-[#7C93A8]
              [&_li]:mt-1.5
              [&_hr]:my-6 [&_hr]:border-[#243329]
              [&_blockquote]:mt-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[#34D399]/40 [&_blockquote]:pl-4 [&_blockquote]:text-[#E6EFE8]
              [&_code]:rounded [&_code]:bg-[#1A2620] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#E6EFE8]
              [&_pre]:mt-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[#243329] [&_pre]:bg-[#0E1512] [&_pre]:p-4
              [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[#8CA495]
              [&_table]:mt-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left
              [&_th]:border-b [&_th]:border-[#243329] [&_th]:px-3 [&_th]:py-2 [&_th]:font-mono [&_th]:text-[10px] [&_th]:font-normal [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-[#7C93A8]
              [&_td]:border-b [&_td]:border-[#243329] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-xs
            "
          >
            <Markdown remarkPlugins={[remarkGfm]}>{doc.markdown}</Markdown>
          </div>
        </article>
      </div>
    </main>
  );
}
