import type { Metadata } from "next";
import ScanTool from "./ScanTool";

export const metadata: Metadata = {
  title: "Free AI Visibility Scan",
  description: "Check whether your website is set up to be found by Google Analytics, AI search engines like ChatGPT and Google AI Overviews, and structured data crawlers. Free, instant, no signup.",
  alternates: { canonical: "https://frontiercapitalsignals.com/scan" },
  openGraph: { url: "https://frontiercapitalsignals.com/scan", type: "website" },
};

export default async function ScanPage({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  const { url } = await searchParams;

  return (
    <>
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Free Tool</p>
          <h1 className="text-4xl sm:text-5xl font-black text-ink mb-5 tracking-tight">Is Your Site Invisible to AI Search?</h1>
          <p className="text-slate-500 text-lg">
            Enter any website below. We&apos;ll check its analytics tracking, structured data, and AI-crawler readiness in seconds — free, no signup.
          </p>
        </div>
      </section>

      <section className="py-16 bg-white min-h-screen">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
          <ScanTool prefillUrl={url} />
        </div>
      </section>
    </>
  );
}
