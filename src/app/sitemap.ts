import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/posts";

const BASE = "https://frontiercapitalsignals.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/intelligence`, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/services`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/resources`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE}/contact`, changeFrequency: "monthly", priority: 0.6 },
  ];

  const postRoutes: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${BASE}/intelligence/${p.slug}`,
    lastModified: new Date(p.date),
    changeFrequency: "never",
    priority: 0.7,
  }));

  return [...staticRoutes, ...postRoutes];
}
