import type { Metadata } from "next";
import { getAllPosts } from "@/lib/posts";
import PostCard from "@/components/PostCard";
import IntelligenceFilters from "@/components/IntelligenceFilters";

export const metadata: Metadata = {
  title: "Intelligence Feed",
  description:
    "Daily AI-curated investment intelligence for Ghana, Nigeria, Kenya, Malawi, and Uganda. Government projects, infrastructure deals, energy tenders, regulatory changes.",
};

export default function IntelligencePage() {
  const posts = getAllPosts();

  return (
    <>
      <section className="bg-navy-800 border-b border-navy-600 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-gold/30 bg-gold/10 mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
                <span className="text-gold text-xs font-semibold tracking-wide uppercase">Updated Daily</span>
              </div>
              <h1 className="text-4xl font-black text-white">Market Intelligence</h1>
              <p className="text-slate-400 mt-2 max-w-xl">
                AI-analyzed signals from government portals, tender databases, energy registries, and on-ground sources across our five focus markets.
              </p>
            </div>
            <div className="text-sm text-slate-500 text-right shrink-0">
              <span className="text-white font-bold text-lg">{posts.length}</span> signals published
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 bg-navy min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {posts.length === 0 ? (
            <div className="text-center py-24">
              <div className="text-5xl mb-4">📡</div>
              <h2 className="text-xl font-bold text-white mb-2">Intelligence loading...</h2>
              <p className="text-slate-500 text-sm">
                Our AI is scanning markets. Run the content generation script or check back tomorrow.
              </p>
            </div>
          ) : (
            <IntelligenceFilters posts={posts} />
          )}
        </div>
      </section>
    </>
  );
}
