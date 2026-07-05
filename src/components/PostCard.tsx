import Link from "next/link";
import Image from "next/image";
import { Post } from "@/lib/posts";

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

function cardImageUrl(post: Post) {
  // Use the stored URL from generation; fall back to Picsum seeded by slug (free, consistent)
  return post.image ?? `https://picsum.photos/seed/${encodeURIComponent(post.slug)}/600/340`;
}

export default function PostCard({ post }: { post: Post }) {
  const flag = countryFlag[post.country] ?? "🌍";
  const catStyle = categoryColor[post.category] ?? categoryColor.General;

  return (
    <Link href={`/intelligence/${post.slug}`} className="group block h-full">
      <article className="bg-white border border-gray-200 rounded-xl overflow-hidden hover:border-gold/60 hover:shadow-lg hover:shadow-gray-200 transition-all duration-300 h-full flex flex-col">
        <div className="relative h-44 overflow-hidden bg-gray-100">
          <Image
            src={cardImageUrl(post)}
            alt={post.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            unoptimized
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
          <div className="absolute top-3 left-3">
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${catStyle}`}>{post.category}</span>
          </div>
          <div className="absolute top-3 right-3 text-xl">{flag}</div>
        </div>
        <div className="p-5 flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-gold-dim text-xs font-semibold">{post.country}</span>
            <time className="text-slate-600 text-xs">{post.date}</time>
          </div>
          <h3 className="text-ink font-bold text-sm leading-snug mb-2 group-hover:text-gold-dim transition-colors line-clamp-2">
            {post.title}
          </h3>
          <p className="text-slate-600 text-xs leading-relaxed line-clamp-3 flex-1">{post.summary}</p>
          <div className="mt-4 text-gold-dim text-xs font-semibold flex items-center gap-1">
            Read analysis
            <svg className="w-3 h-3 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </div>
      </article>
    </Link>
  );
}
