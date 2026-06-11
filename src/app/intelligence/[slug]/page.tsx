import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getPostBySlug, getAllPosts } from "@/lib/posts";

export async function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.summary,
    openGraph: {
      title: post.title,
      description: post.summary,
      type: "article",
      publishedTime: post.date,
    },
  };
}

const countryFlag: Record<string, string> = {
  Ghana: "🇬🇭",
  Nigeria: "🇳🇬",
  Kenya: "🇰🇪",
  Malawi: "🇲🇼",
  Uganda: "🇺🇬",
  Africa: "🌍",
};

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const imageUrl = `https://source.unsplash.com/featured/1200x630?${encodeURIComponent(post.imageQuery + " Africa")}`;

  return (
    <article className="bg-navy min-h-screen">
      {/* Hero image */}
      <div className="relative h-72 sm:h-96 w-full overflow-hidden">
        <Image src={imageUrl} alt={post.title} fill className="object-cover" unoptimized priority />
        <div className="absolute inset-0 bg-gradient-to-t from-navy via-navy/60 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 max-w-4xl mx-auto px-4 sm:px-6 pb-8">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-2xl">{countryFlag[post.country] ?? "🌍"}</span>
            <span className="text-gold text-sm font-semibold">{post.country}</span>
            <span className="text-slate-500 text-sm">·</span>
            <span className="bg-navy-700 text-slate-300 text-xs font-semibold px-2 py-0.5 rounded">{post.category}</span>
            <span className="text-slate-500 text-sm">·</span>
            <time className="text-slate-400 text-sm">{post.date}</time>
          </div>
          <h1 className="text-2xl sm:text-4xl font-black text-white leading-tight">{post.title}</h1>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Summary callout */}
        <div className="bg-navy-800 border border-gold/30 rounded-xl p-5 mb-10">
          <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-2">Intelligence Summary</p>
          <p className="text-slate-200 leading-relaxed">{post.summary}</p>
        </div>

        {/* Body */}
        <div
          className="prose-investment"
          dangerouslySetInnerHTML={{ __html: post.content ?? "" }}
        />

        {/* Disclaimer */}
        <div className="mt-12 pt-8 border-t border-navy-600">
          <p className="text-slate-600 text-xs">
            This intelligence report is provided for informational purposes only and does not constitute investment advice. Frontier Capital Signals makes no representations as to the accuracy, completeness, or timeliness of this information. Always conduct independent due diligence before making investment decisions.
          </p>
        </div>

        {/* Back link */}
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
