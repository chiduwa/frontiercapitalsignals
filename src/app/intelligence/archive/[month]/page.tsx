import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getAllPosts, monthLabel, postMonths } from "@/lib/posts";

// A plain list of every brief in a month. /intelligence now draws only the
// newest cards, so these pages keep each brief one crawlable link from the feed.
export const dynamicParams = false;

export async function generateStaticParams() {
  return postMonths().map(({ month }) => ({ month }));
}

export async function generateMetadata({ params }: { params: Promise<{ month: string }> }): Promise<Metadata> {
  const { month } = await params;
  const label = monthLabel(month);
  const canonical = `https://frontiercapitalsignals.com/intelligence/archive/${month}`;
  return {
    title: `Intelligence Archive: ${label}`,
    description: `Every Frontier Capital Signals brief published in ${label} on Ghana, Nigeria, Kenya, Malawi and Uganda, newest first.`,
    alternates: { canonical },
    openGraph: { url: canonical, type: "website", images: [{ url: "/opengraph-image", width: 1200, height: 630 }] },
  };
}

export default async function IntelligenceArchiveMonth({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  const posts = getAllPosts().filter((p) => p.date.startsWith(`${month}-`));
  if (posts.length === 0) notFound();
  const months = postMonths();

  return (
    <section className="py-14 bg-white min-h-screen">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link href="/intelligence" className="text-gold-dim text-sm font-semibold hover:text-gold">
          &larr; Intelligence feed
        </Link>
        <h1 className="text-3xl font-black text-ink tracking-tight mt-4">{monthLabel(month)}</h1>
        <p className="text-slate-600 text-sm mt-2 mb-8">{posts.length} briefs, newest first.</p>

        <ol className="divide-y divide-gray-100">
          {posts.map((p) => (
            <li key={p.slug} className="py-3 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
              <time dateTime={p.date} className="text-slate-600 text-xs tabular-nums shrink-0 sm:w-24">{p.date}</time>
              <Link href={`/intelligence/${p.slug}`} className="text-ink text-sm font-semibold hover:text-gold-dim">
                {p.title}
              </Link>
              <span className="text-slate-600 text-xs sm:ml-auto shrink-0">{p.country} &middot; {p.category}</span>
            </li>
          ))}
        </ol>

        <nav aria-label="Other months" className="mt-12 pt-6 border-t border-gray-200">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {months.map(({ month: m }) => (
              <li key={m}>
                {m === month ? (
                  <span aria-current="page" className="text-ink font-semibold">{monthLabel(m)}</span>
                ) : (
                  <Link href={`/intelligence/archive/${m}`} className="text-gold-dim font-semibold underline underline-offset-2 hover:text-gold">
                    {monthLabel(m)}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}
