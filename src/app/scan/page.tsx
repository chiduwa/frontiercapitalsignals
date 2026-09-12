import type { Metadata } from "next";
import ScanTool from "./ScanTool";

export const metadata: Metadata = {
  title: "Free AI Visibility Scan",
  description: "Check page titles, descriptions, canonical tags, structured data, and crawler policy. A free technical checklist with no signup.",
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
          <h1 className="text-4xl sm:text-5xl font-black text-ink mb-5 tracking-tight">Check Your Site’s Search Basics</h1>
          <p className="text-slate-500 text-lg">
            Enter a public page URL to review its search metadata and crawler policy. Free, with no signup.
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
