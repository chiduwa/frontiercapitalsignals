"use client";
import { useState } from "react";
import PostCard from "@/components/PostCard";
import type { PostCardData } from "@/lib/posts";

const COUNTRIES = ["All", "Ghana", "Nigeria", "Kenya", "Malawi", "Uganda"];
const CATEGORIES = ["All", "Infrastructure", "Energy", "Mining", "Agriculture", "Finance", "Tech", "Regulatory", "Startup", "General"];

// Rendering all ~2,000 cards made this page 5.6 MB of HTML and 1.5 s of
// main-thread blocking on a phone (PageSpeed 41). Filters still search every
// post; only the cards drawn are capped, and the month archive links them all.
const PAGE_SIZE = 24;

export default function IntelligenceFilters({ posts }: { posts: PostCardData[] }) {
  const [country, setCountry] = useState("All");
  const [category, setCategory] = useState("All");
  const [shown, setShown] = useState(PAGE_SIZE);

  const filtered = posts.filter((p) => {
    if (country !== "All" && p.country !== country) return false;
    if (category !== "All" && p.category !== category) return false;
    return true;
  });

  return (
    <>
      {/* Filters */}
      <div className="mb-8 space-y-4">
        <div>
          <p className="text-slate-600 text-xs font-semibold tracking-widest uppercase mb-2">Country</p>
          <div className="flex flex-wrap gap-2">
            {COUNTRIES.map((c) => (
              <button
                key={c}
                onClick={() => { setCountry(c); setShown(PAGE_SIZE); }}
                aria-pressed={country === c}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  country === c
                    ? "bg-navy text-white"
                    : "bg-white border border-gray-200 text-slate-600 hover:border-navy hover:text-navy"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-slate-600 text-xs font-semibold tracking-widest uppercase mb-2">Sector</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => { setCategory(c); setShown(PAGE_SIZE); }}
                aria-pressed={category === c}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  category === c
                    ? "gradient-gold text-white"
                    : "bg-white border border-gray-200 text-slate-600 hover:border-gold hover:text-gold-dim"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Count */}
      <p className="text-slate-600 text-sm mb-6">
        Showing <span className="text-ink font-semibold">{Math.min(shown, filtered.length)}</span> of {filtered.length} reports
      </p>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-600">
          No reports match the selected filters.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.slice(0, shown).map((post) => <PostCard key={post.slug} post={post} />)}
          </div>
          {filtered.length > shown && (
            <div className="mt-10 text-center">
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE_SIZE * 2)}
                className="px-5 py-2.5 rounded-lg border border-gray-200 text-sm font-semibold text-ink hover:border-navy transition-colors"
              >
                Show more ({filtered.length - shown} older)
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
