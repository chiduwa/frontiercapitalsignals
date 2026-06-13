import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getPostBySlug, getAllPosts } from "@/lib/posts";

export async function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.summary,
    openGraph: { title: post.title, description: post.summary, type: "article", publishedTime: post.date },
  };
}

const countryFlag: Record<string, string> = {
  Ghana: "🇬🇭", Nigeria: "🇳🇬", Kenya: "🇰🇪", Malawi: "🇲🇼", Uganda: "🇺🇬", Africa: "🌍",
};

const categoryColor: Record<string, string> = {
  Energy: "bg-amber-100 text-amber-700",
  Infrastructure: "bg-blue-100 text-blue-700",
  Mining: "bg-orange-100 text-orange-700",
  Agriculture: "bg-green-100 text-green-700",
  Tech: "bg-purple-100 text-purple-700",
  Finance: "bg-emerald-100 text-emerald-700",
  Regulatory: "bg-red-100 text-red-700",
  Startup: "bg-pink-100 text-pink-700",
  General: "bg-gray-100 text-gray-600",
};

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const imageUrl = `https://source.unsplash.com/featured/1200x500?${encodeURIComponent(post.imageQuery + " Africa")}`;
  const catStyle = categoryColor[post.category] ?? categoryColor.General;

  return (
    <article className="bg-white min-h-screen">
      {/* Hero image */}
      <div className="relative h-64 sm:h-80 w-full overflow-hidden bg-gray-100">
        <Image src={imageUrl} alt={post.title} fill className="object-cover" unoptimized priority />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Meta */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <span className="text-2xl">{countryFlag[post.country] ?? "🌍"}</span>
          <span className="text-gold font-semibold text-sm">{post.country}</span>
          <span className="text-gray-300">·</span>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${catStyle}`}>{post.category}</span>
          <span className="text-gray-300">·</span>
          <time className="text-slate-400 text-sm">{post.date}</time>
        </div>

        <h1 className="text-3xl sm:text-4xl font-black text-ink leading-tight mb-6 tracking-tight">{post.title}</h1>

        {/* Summary callout */}
        <div className="bg-amber-50 border-l-4 border-gold rounded-r-xl px-6 py-4 mb-10">
          <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-2">Intelligence Summary</p>
          <p className="text-slate-700 leading-relaxed text-sm">{post.summary}</p>
        </div>

        {/* Body */}
        <div className="prose-investment" dangerouslySetInnerHTML={{ __html: post.content ?? "" }} />

        {/* Disclaimer */}
        <div className="mt-12 pt-8 border-t border-gray-100">
          <p className="text-slate-400 text-xs leading-relaxed">
            This intelligence report is provided for informational purposes only and does not constitute investment advice. Frontier Capital Signals makes no representations as to the accuracy, completeness, or timeliness of this information. Always conduct independent due diligence before making investment decisions.
          </p>
        </div>

        {/* Back */}
        <div className="mt-8">
          <Link href="/intelligence" className="inline-flex items-center gap-2 text-gold text-sm font-semibold hover:text-gold-light transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Intelligence Feed
          </Link>
        </div>
      </div>
    </article>
  );
}
