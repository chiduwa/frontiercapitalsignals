"use client";
import { useState } from "react";
import PostCard from "@/components/PostCard";
import type { Post } from "@/lib/posts";

const COUNTRIES = ["All", "Ghana", "Nigeria", "Kenya", "Malawi", "Uganda"];
const CATEGORIES = ["All", "Infrastructure", "Energy", "Mining", "Agriculture", "Finance", "Tech", "Regulatory", "Startup", "General"];

export default function IntelligenceFilters({ posts }: { posts: Post[] }) {
  const [country, setCountry] = useState("All");
  const [category, setCategory] = useState("All");

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
          <p className="text-slate-500 text-xs font-semibold tracking-widest uppercase mb-2">Country</p>
          <div className="flex flex-wrap gap-2">
            {COUNTRIES.map((c) => (
              <button
                key={c}
                onClick={() => setCountry(c)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  country === c
                    ? "gradient-gold text-navy"
                    : "bg-navy-800 border border-navy-600 text-slate-400 hover:text-white hover:border-gold/40"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-slate-500 text-xs font-semibold tracking-widest uppercase mb-2">Sector</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  category === c
                    ? "gradient-gold text-navy"
                    : "bg-navy-800 border border-navy-600 text-slate-400 hover:text-white hover:border-gold/40"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results count */}
      <p className="text-slate-500 text-sm mb-6">
        Showing <span className="text-white font-semibold">{filtered.length}</span> intelligence reports
      </p>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          No reports match the selected filters. Try broadening your criteria.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      )}
    </>
  );
}
