import type { Metadata } from "next";
import Link from "next/link";
import JsonLd from "@/components/JsonLd";
import AuditRequestForm from "@/components/AuditRequestForm";

export const metadata: Metadata = {
  title: "AI Visibility Audit",
  description: "A fixed-price audit and fix for small business websites: broken Google Analytics, missing structured data, and invisibility to AI search engines like ChatGPT and Google AI Overviews.",
  alternates: { canonical: "https://frontiercapitalsignals.com/audit" },
  keywords: ["AI visibility audit", "GA4 audit", "Google Tag Manager fix", "generative engine optimization", "GEO audit small business", "AI search optimization"],
  openGraph: { url: "https://frontiercapitalsignals.com/audit", type: "website" },
};

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  serviceType: "AI Visibility and Analytics Audit",
  provider: { "@type": "Organization", name: "Frontier Capital Signals", url: "https://frontiercapitalsignals.com" },
  areaServed: "Worldwide",
  description: "Fixed-price audit and implementation fixing broken Google Analytics/Tag Manager setups and preparing small business websites to be found by AI search engines.",
  offers: [
    { "@type": "Offer", name: "Standard Fix", price: "349", priceCurrency: "USD" },
    { "@type": "Offer", name: "Full AI Visibility Package", price: "599", priceCurrency: "USD" },
  ],
};

const problems = [
  { icon: "📉", title: "Analytics That Isn't Tracking", desc: "Most small business sites have Google Analytics installed wrong — an empty Tag Manager container, a Consent Mode bug, or a tag that silently stopped firing months ago. You're making decisions on data that isn't there." },
  { icon: "🤖", title: "Invisible to AI Search", desc: "ChatGPT, Google AI Overviews, and Perplexity now answer a quarter of searches directly — and those visitors convert 4-8x better than regular search traffic. Sites without structured data and the right crawler access don't show up at all." },
  { icon: "💸", title: "Agencies Price You Out", desc: "\"Generative engine optimization\" retainers run $1,500-$5,000/month at most agencies. Most small businesses don't need an ongoing retainer — they need the actual problems found and fixed, once." },
];

const included = [
  "Full audit: GA4/Google Tag Manager configuration, Consent Mode, and event tracking",
  "Structured data (schema.org) implementation for your business type",
  "Meta tags, canonical tags, and Open Graph fixes",
  "robots.txt and llms.txt configured for AI-crawler visibility",
  "Google Search Console indexing check and sitemap resubmission",
  "A plain-English report of what was broken and what was fixed",
];

export default function AuditPage() {
  return (
    <>
      <JsonLd data={serviceSchema} />

      {/* Header */}
      <section className="bg-sand border-b border-gray-200 py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">AI Visibility Audit</p>
          <h1 className="text-4xl sm:text-5xl font-black text-ink mb-6 tracking-tight leading-tight">
            Find Out What&apos;s Broken. Then We Fix It.
          </h1>
          <p className="text-slate-500 text-lg mb-8 max-w-2xl mx-auto">
            A fixed-price audit that finds why your analytics don&apos;t track and why AI search engines can&apos;t see your business — then implements every fix. No retainer required.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/scan" className="px-8 py-3.5 rounded-lg gradient-gold text-white font-bold hover:opacity-90 transition-opacity">
              Run a Free Scan First
            </Link>
            <Link href="#pricing" className="px-8 py-3.5 rounded-lg border border-gray-300 text-ink font-semibold hover:bg-white transition-colors">
              See Pricing
            </Link>
          </div>
        </div>
      </section>

      {/* Problems */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {problems.map(({ icon, title, desc }) => (
              <div key={title} className="bg-sand border border-gray-200 rounded-xl p-6">
                <div className="text-3xl mb-4">{icon}</div>
                <h3 className="text-ink font-bold mb-2">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What's included */}
      <section className="py-20 bg-sand border-y border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">What&apos;s Included</p>
            <h2 className="text-3xl sm:text-4xl font-black text-ink tracking-tight">Every Audit Covers This</h2>
          </div>
          <ul className="space-y-3 max-w-2xl mx-auto">
            {included.map((item) => (
              <li key={item} className="flex items-start gap-3 bg-white border border-gray-200 rounded-xl p-4">
                <svg className="w-5 h-5 text-gold mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-slate-600">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 bg-white scroll-mt-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Pricing</p>
            <h2 className="text-3xl sm:text-4xl font-black text-ink tracking-tight">Fixed Price. No Retainer.</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="border border-gray-200 rounded-2xl p-8">
              <h3 className="text-ink font-black text-lg mb-1">Free Scan</h3>
              <p className="text-4xl font-black text-ink mb-4">$0</p>
              <p className="text-slate-500 text-sm mb-6">An instant automated check of your analytics, structured data, and AI-crawler readiness.</p>
              <Link href="/scan" className="block text-center py-3 rounded-lg border border-gray-300 text-ink font-semibold text-sm hover:bg-gray-50 transition-colors">Run It Free</Link>
            </div>
            <div className="border-2 border-gold rounded-2xl p-8 relative">
              <span className="absolute -top-3 left-8 text-xs font-semibold px-2.5 py-0.5 rounded-full gradient-gold text-white">Most Popular</span>
              <h3 className="text-ink font-black text-lg mb-1">Standard Fix</h3>
              <p className="text-4xl font-black text-ink mb-4">$349</p>
              <p className="text-slate-500 text-sm mb-6">Analytics repair, structured data, meta/canonical/OG tags, one-time. Delivered in 3-5 business days.</p>
              <a href="#request" className="block text-center py-3 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity">Get Started</a>
            </div>
            <div className="border border-gray-200 rounded-2xl p-8">
              <h3 className="text-ink font-black text-lg mb-1">Full AI Visibility Package</h3>
              <p className="text-4xl font-black text-ink mb-4">$599</p>
              <p className="text-slate-500 text-sm mb-6">Everything in Standard, plus llms.txt, AI-crawler policy tuning, Search Console indexing check, and a 30-day follow-up.</p>
              <a href="#request" className="block text-center py-3 rounded-lg border border-gray-300 text-ink font-semibold text-sm hover:bg-gray-50 transition-colors">Get Started</a>
            </div>
          </div>
          <p className="text-slate-500 text-sm text-center mt-8">Want ongoing monitoring? Ask about the $129/mo add-on after your first audit.</p>
        </div>
      </section>

      {/* Request form */}
      <section id="request" className="py-20 bg-navy scroll-mt-16">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-black text-white mb-3">Get Started</h2>
            <p className="text-white/60 text-sm">Tell us your site and package. We&apos;ll follow up within one business day.</p>
          </div>
          <AuditRequestForm />
        </div>
      </section>
    </>
  );
}
