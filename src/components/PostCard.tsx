import Link from "next/link";
import Image from "next/image";
import { Post } from "@/lib/posts";

const countryFlag: Record<string, string> = {
  Ghana: "🇬🇭",
  Nigeria: "🇳🇬",
  Kenya: "🇰🇪",
  Malawi: "🇲🇼",
  Uganda: "🇺🇬",
  Africa: "🌍",
};

const categoryColor: Record<string, string> = {
  Energy: "bg-amber-500/20 text-amber-400",
  Infrastructure: "bg-blue-500/20 text-blue-400",
  Mining: "bg-orange-500/20 text-orange-400",
  Agriculture: "bg-green-500/20 text-green-400",
  Tech: "bg-purple-500/20 text-purple-400",
  Finance: "bg-emerald-fcs/20 text-emerald-400",
  Regulatory: "bg-red-500/20 text-red-400",
  Startup: "bg-pink-500/20 text-pink-400",
  General: "bg-navy-600/60 text-slate-400",
};

function unsplashUrl(query: string, w = 600, h = 340) {
  const encoded = encodeURIComponent(query + " Africa");
  return `https://source.unsplash.com/featured/${w}x${h}?${encoded}`;
}

export default function PostCard({ post }: { post: Post }) {
  const flag = countryFlag[post.country] ?? "🌍";
  const catStyle = categoryColor[post.category] ?? categoryColor.General;

  return (
    <Link href={`/intelligence/${post.slug}`} className="group block">
      <article className="bg-navy-800 border border-navy-600 rounded-xl overflow-hidden hover:border-gold/50 transition-all duration-300 hover:shadow-lg hover:shadow-gold/5 h-full flex flex-col">
        <div className="relative h-44 overflow-hidden">
          <Image
            src={unsplashUrl(post.imageQuery)}
            alt={post.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            unoptimized
          />
          <div className="absolute inset-0 bg-gradient-to-t from-navy-800/80 to-transparent" />
          <div className="absolute top-3 left-3 flex gap-2">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${catStyle}`}>{post.category}</span>
          </div>
          <div className="absolute top-3 right-3 text-lg">{flag}</div>
        </div>
        <div className="p-4 flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gold text-xs font-medium">{post.country}</span>
            <time className="text-slate-500 text-xs">{post.date}</time>
          </div>
          <h3 className="text-white font-semibold text-sm leading-snug mb-2 group-hover:text-gold-light transition-colors line-clamp-2">
            {post.title}
          </h3>
          <p className="text-slate-400 text-xs leading-relaxed line-clamp-3 flex-1">{post.summary}</p>
          <div className="mt-3 text-gold text-xs font-semibold flex items-center gap-1">
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
