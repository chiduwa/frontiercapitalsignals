import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkHtml from "remark-html";

const CONTENT_DIR = path.join(process.cwd(), "content/intelligence");

export interface Post {
  slug: string;
  title: string;
  date: string;
  summary: string;
  country: string;
  category: string;
  imageQuery: string;
  content?: string;
}

function ensureDir() {
  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
}

export function getAllPosts(): Post[] {
  ensureDir();
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
  const posts = files.map((filename) => {
    const slug = filename.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(CONTENT_DIR, filename), "utf8");
    const { data } = matter(raw);
    return {
      slug,
      title: data.title || "Untitled",
      date: data.date || "",
      summary: data.summary || "",
      country: data.country || "Africa",
      category: data.category || "General",
      imageQuery: data.imageQuery || "Africa business",
    } as Post;
  });
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  ensureDir();
  const filePath = path.join(CONTENT_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(raw);
  const processed = await remark().use(remarkHtml).process(content);
  return {
    slug,
    title: data.title || "Untitled",
    date: data.date || "",
    summary: data.summary || "",
    country: data.country || "Africa",
    category: data.category || "General",
    imageQuery: data.imageQuery || "Africa business",
    content: processed.toString(),
  };
}

export function getLatestPosts(n = 6): Post[] {
  return getAllPosts().slice(0, n);
}
