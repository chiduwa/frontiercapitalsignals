import type { Metadata } from "next";
import { getAllPosts } from "@/lib/posts";
import IntelligenceFilters from "@/components/IntelligenceFilters";

export const metadata: Metadata = {
  title: "Intelligence Feed",
  description: "Daily AI-curated investment intelligence for Ghana, Nigeria, Kenya, Malawi, and Uganda. Government projects, infrastructure tenders, energy deals, regulatory changes.",
  alternates: { canonical: "https://frontiercapitalsignals.com/intelligence" },
  keywords: ["Africa investment news", "Ghana investment opportunities 2025", "Nigeria business intelligence", "Kenya infrastructure deals", "Malawi mining", "Uganda oil investment", "Africa emerging market signals", "frontier market intelligence daily"],
  openGraph: { url: "https://frontiercapitalsignals.com/intelligence", type: "website" },
};

export default function IntelligencePage() {
  const posts = getAllPosts();

  return (
    <>
      <section className="bg-sand border-b border-gray-200 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gold/10 border border-gold/30 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
                <span className="text-gold text-xs font-semibold tracking-widest uppercase">Updated Daily</span>
              </div>
              <h1 className="text-4xl font-black text-ink tracking-tight">Market Intelligence</h1>
              <p className="text-slate-500 mt-2 max-w-xl text-sm leading-relaxed">
                AI-analyzed signals from government portals, tender databases, energy registries, and on-ground sources across Ghana, Nigeria, Kenya, Malawi, and Uganda.
              </p>
            </div>
            <div className="text-sm text-slate-400 text-right shrink-0">
              <span className="text-ink font-bold text-2xl">{posts.length}</span>
              <span className="ml-1">signals published</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 bg-white min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {posts.length === 0 ? (
            <div className="text-center py-24">
              <div className="text-5xl mb-4">📡</div>
              <h2 className="text-xl font-bold text-ink mb-2">Intelligence loading...</h2>
              <p className="text-slate-400 text-sm">Run the content generation script or check back tomorrow.</p>
            </div>
          ) : (
            <IntelligenceFilters posts={posts} />
          )}
        </div>
      </section>
    </>
  );
}
