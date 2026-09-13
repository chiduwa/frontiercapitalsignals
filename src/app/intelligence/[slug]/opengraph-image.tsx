// Per-article social card.
//
// Article metadata previously fell back to `https://picsum.photos/seed/<slug>/1200/630`
// when a post had no image — a random stock photo, unrelated to the story, on
// every social and chat preview of a financial intelligence report. This renders
// the headline itself on the site's own navy-and-gold card instead, so the
// preview always carries the actual story and the brand.

import { ImageResponse } from "next/og";
import { getPostBySlug, getAllPosts } from "@/lib/posts";

// Without this the route is server-rendered on demand, and at request time in
// the Workers runtime the post lookup returns null — the card then renders its
// fallback ("Frontier Capital Signals" / Africa / Intelligence) instead of the
// article, which is most of the point of having it. Prerendering it alongside
// the page means the lookup happens at build time, where the content files are
// actually readable.
export async function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Frontier Capital Signals intelligence report";

const NAVY = "#0a0f1e";
const GOLD = "#c9962a";
const GOLD_BORDER = "rgba(201,150,42,0.45)";
const WHITE = "#ffffff";
const WHITE_70 = "rgba(255,255,255,0.70)";

/** Long headlines need a smaller face to stay inside the card. */
function headlineSize(length: number): number {
  if (length <= 60) return 62;
  if (length <= 90) return 52;
  return 44;
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  const headline = post?.title ?? "Frontier Capital Signals";
  const country = post?.country ?? "Africa";
  const category = post?.category ?? "Intelligence";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: NAVY,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, background: GOLD, display: "flex" }} />
          <div
            style={{
              display: "flex",
              color: GOLD,
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            Frontier Capital Signals
          </div>
        </div>

        <div
          style={{
            display: "flex",
            color: WHITE,
            fontSize: headlineSize(headline.length),
            fontWeight: 800,
            lineHeight: 1.18,
            letterSpacing: -1,
          }}
        >
          {headline}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              display: "flex",
              border: `1px solid ${GOLD_BORDER}`,
              borderRadius: 999,
              padding: "10px 22px",
              color: GOLD,
              fontSize: 24,
              fontWeight: 600,
            }}
          >
            {country}
          </div>
          <div
            style={{
              display: "flex",
              border: `1px solid ${GOLD_BORDER}`,
              borderRadius: 999,
              padding: "10px 22px",
              color: WHITE_70,
              fontSize: 24,
              fontWeight: 600,
            }}
          >
            {category}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
