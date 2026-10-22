// Registry of long-form research pages under /research.
//
// Each study is a hand-built page (tables and structured data differ too much
// between studies for one markdown template), so this list is what the hub,
// the sitemap and llms.txt read to know which studies exist.

export type ResearchStudy = {
  slug: string;
  title: string;
  description: string;
  published: string; // ISO date
  modified: string; // ISO date
  topics: string[];
};

export const RESEARCH_BASE = "https://frontiercapitalsignals.com/research";

export const studies: ResearchStudy[] = [
  {
    slug: "binance-grid-bots",
    title: "Binance Grid Bots Tested: Best Spot and Futures Settings",
    description:
      "72,280 Binance grid bots replayed on 2021–2026 prices. Which bot to run, the range and grid count for BTC and ETH, and when the Arbitrage Bot beats a grid.",
    published: "2026-09-29",
    modified: "2026-09-29",
    topics: ["Binance", "Grid trading", "Crypto trading bots", "Funding rate arbitrage"],
  },
];

export function studyUrl(slug: string): string {
  return `${RESEARCH_BASE}/${slug}`;
}

export function getStudy(slug: string): ResearchStudy {
  const study = studies.find((s) => s.slug === slug);
  if (!study) throw new Error(`Unknown research study: ${slug}`);
  return study;
}
