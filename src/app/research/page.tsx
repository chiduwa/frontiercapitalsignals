import type { Metadata } from "next";
import Link from "next/link";
import JsonLd from "@/components/JsonLd";
import { studies, studyUrl, RESEARCH_BASE } from "@/lib/research";

export const metadata: Metadata = {
  title: "Quant Research",
  description:
    "Open, reproducible trading research from Frontier Capital Signals: crypto trading bots, grid bot settings, funding rates and signal testing on real market data.",
  alternates: { canonical: RESEARCH_BASE },
  keywords: [
    "crypto trading bot research",
    "Binance grid bot backtest",
    "quant research crypto",
    "trading bot settings tested",
    "funding rate arbitrage research",
  ],
  // Declaring openGraph here replaces the root layout's block entirely,
  // including its image, so the site card has to be named again.
  openGraph: { url: RESEARCH_BASE, type: "website", images: [{ url: "/opengraph-image", width: 1200, height: 630 }] },
};

const collectionSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Frontier Capital Signals Quant Research",
  url: RESEARCH_BASE,
  hasPart: studies.map((s) => ({
    "@type": "Article",
    headline: s.title,
    url: studyUrl(s.slug),
    datePublished: s.published,
    dateModified: s.modified,
  })),
};

export default function ResearchPage() {
  return (
    <>
      <JsonLd data={collectionSchema} />
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Research</p>
            <h1 className="text-5xl font-black text-ink mb-4 tracking-tight">Quant Research</h1>
            <p className="text-slate-500 text-lg leading-relaxed">
              The studies behind our <a href="/signals" className="text-gold-dim underline">signals</a>, written
              up in plain language. Every claim is replayed on real market data with fees, tested against a
              baseline, and published whether or not it made money.
            </p>
          </div>
        </div>
      </section>

      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid gap-6 md:grid-cols-2">
          {studies.map((s) => (
            <Link
              key={s.slug}
              href={`/research/${s.slug}`}
              className="block border border-gray-200 rounded-2xl p-6 hover:border-gold transition-colors"
            >
              <time dateTime={s.published} className="text-slate-500 text-xs">
                {s.published}
              </time>
              <h2 className="text-xl font-black text-ink tracking-tight mt-2 mb-2">{s.title}</h2>
              <p className="text-slate-600 text-sm leading-relaxed">{s.description}</p>
              <p className="text-gold-dim text-xs font-semibold mt-4">{s.topics.join(" · ")}</p>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
