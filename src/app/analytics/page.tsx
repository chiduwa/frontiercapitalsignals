import type { Metadata } from "next";
import Link from "next/link";
import JsonLd from "@/components/JsonLd";
import ServiceIcon from "@/components/ServiceIcon";

export const metadata: Metadata = {
  title: "Data & Business Analytics",
  description:
    "Dashboards, data pipelines, forecasting, business analysis and marketing analytics, built by the team behind this site's own market data and research systems.",
  alternates: { canonical: "https://frontiercapitalsignals.com/analytics" },
  keywords: [
    "business analytics services",
    "data analytics consulting Africa",
    "dashboard development",
    "business intelligence Ghana",
    "data pipeline consulting",
    "forecasting and modelling",
    "marketing analytics agency",
    "data analytics Nigeria Kenya",
  ],
  // Declaring openGraph here replaces the root layout's block entirely,
  // including its image, so the site card has to be named again.
  openGraph: { url: "https://frontiercapitalsignals.com/analytics", type: "website", images: [{ url: "/opengraph-image", width: 1200, height: 630 }] },
};

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  serviceType: "Data and Business Analytics",
  provider: { "@type": "Organization", name: "Frontier Capital Signals", url: "https://frontiercapitalsignals.com" },
  areaServed: "Worldwide",
  url: "https://frontiercapitalsignals.com/analytics",
  description:
    "Dashboards and reporting, data pipelines and integration, business analysis, forecasting and modelling, web and marketing analytics, and analytics automation for investors, operating companies and small businesses.",
  hasOfferCatalog: {
    "@type": "OfferCatalog",
    name: "Data and Business Analytics",
    itemListElement: [
      "Dashboards and Reporting",
      "Data Pipelines and Integration",
      "Business Analysis",
      "Forecasting and Modelling",
      "Web and Marketing Analytics",
      "Automation and AI Tooling",
    ].map((name) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name } })),
  },
};

// Live parts of this site that the same team built, used as proof rather than
// claims. /signals is a separate Cloudflare Worker, so it needs a plain <a>.
const proof = [
  { href: "/signals", label: "Signals engine", note: "Hourly screens across 440+ assets, with setups withheld when they cannot clear their own baseline.", external: true },
  { href: "/exchanges", label: "Exchange data", note: "Five African stock exchanges, priced live in local currency and USD." },
  { href: "/intelligence", label: "Daily research", note: "A pipeline that reads public sources every morning and publishes what changed." },
  { href: "/scan", label: "Free site scan", note: "A small diagnostic tool you can run on your own site right now." },
];

const capabilities = [
  {
    icon: "analytics",
    title: "Dashboards & Reporting",
    desc: "One place to see how the business is doing, refreshed on its own. Sales, cash, stock, projects, whatever you actually run the week on. Built so the people who need it can read it without sitting through a training session.",
  },
  {
    icon: "data-pipeline",
    title: "Data Pipelines & Integration",
    desc: "Your numbers are usually spread across a point of sale system, a bank portal, a few spreadsheets, and somebody's inbox. We connect them into one clean, current source everyone can work from.",
  },
  {
    icon: "insight",
    title: "Business Analysis",
    desc: "The part where a person sits with the data and works out what it means. Pricing, margin, customer behaviour, where the money is quietly leaking. You get an answer and the reasoning behind it, not just a chart.",
  },
  {
    icon: "forecasting",
    title: "Forecasting & Modelling",
    desc: "Demand, cash flow, headcount, project cost. We build models you can change the assumptions on, so you can test a decision on paper before you make it for real.",
  },
  {
    icon: "measurement",
    title: "Web & Marketing Analytics",
    desc: "Tracking that actually fires, events that match the way you really sell, and reporting that shows which channel is worth the spend. If your Google Analytics has been quietly broken for months, this is where we start.",
    href: "/audit",
    hrefLabel: "See the fixed-price audit",
  },
  {
    icon: "automation",
    title: "Automation & AI Tooling",
    desc: "The weekly report that builds itself. The alert that reaches you when a number moves. The document review that used to take a morning. We build these with the same tooling that runs our own research pipeline.",
  },
];

const audiences = [
  {
    title: "Investors & funds",
    desc: "Portfolio reporting, deal screening models, and market sizing built on data you can trace back to its original source.",
    href: "/services",
    hrefLabel: "Our investor services",
  },
  {
    title: "Companies operating in our markets",
    desc: "Operational dashboards, supply chain and cost analysis, and the monthly reporting your board keeps asking for.",
    href: "/contact",
    hrefLabel: "Describe your project",
  },
  {
    title: "Small businesses & nonprofits",
    desc: "You do not need an enterprise contract to get your numbers in order. Start with the fixed-price audit and build from there.",
    href: "/audit",
    hrefLabel: "Start with an audit",
  },
];

const steps = [
  "A short call. You tell us the decision you are trying to make, and we tell you honestly whether better data will help.",
  "We look at what you already have. Systems, spreadsheets, exports, whatever exists. There is usually more there than people expect.",
  "We scope it in writing. Fixed price where the work is well defined, staged where it is not. You know the cost before anything is built.",
  "We build it, hand it over, and show your team how to run it. You own what we build, and you are not locked into us to keep it working.",
];

const startingPoints = [
  { title: "Free site scan", price: "$0", desc: "An instant check of your site's search metadata, structured data, and crawler policy. No signup.", href: "/scan", cta: "Run it free", featured: false },
  { title: "Analytics & visibility audit", price: "From $349", desc: "We find what is broken in your tracking and search setup, then fix it. One payment, no retainer.", href: "/audit", cta: "See what is covered", featured: true },
  { title: "Custom analytics project", price: "Scoped on a call", desc: "Dashboards, pipelines, models, or automation built around how your business actually runs.", href: "/contact", cta: "Tell us what you need", featured: false },
];

export default function AnalyticsPage() {
  return (
    <>
      <JsonLd data={serviceSchema} />

      {/* Header */}
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Data &amp; Business Analytics</p>
            <h1 className="text-4xl sm:text-5xl font-black text-ink mb-5 tracking-tight leading-tight">We Build the Data Side of Your Business</h1>
            <p className="text-slate-500 text-lg leading-relaxed mb-8">
              Dashboards, pipelines, forecasts, and the reporting that sits on top of them. It is the same analytics work that runs this site, pointed at your business instead of ours.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link href="/contact" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity">
                Start a Conversation
              </Link>
              <Link href="#start" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-lg border border-gray-300 text-ink font-semibold text-sm hover:bg-white transition-colors">
                See Where to Start
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Proof — the site itself */}
      <section className="py-24 bg-navy relative overflow-hidden">
        <div className="absolute top-0 right-1/4 w-[500px] h-[300px] bg-gold/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
            <div>
              <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-4">Built Here First</p>
              <h2 className="text-4xl font-black text-white mb-5 tracking-tight">You Are Already Looking at Our Work</h2>
              <p className="text-white/70 text-lg leading-relaxed mb-4 max-w-xl">
                The market data, the daily research, the hourly screens, the scoring behind them. We built all of it ourselves rather than buying a dashboard product and putting our name on it.
              </p>
              <p className="text-white/70 text-lg leading-relaxed max-w-xl">
                So before you commit to anything, you can click around and judge the standard for yourself. That is the same standard we bring to client work.
              </p>
            </div>
            <div className="tilt-stage grid grid-cols-1 sm:grid-cols-2 gap-3">
              {proof.map(({ href, label, note, external }) => {
                const inner = (
                  <>
                    <p className="text-white font-bold text-sm mb-1.5 flex items-center gap-1.5">
                      {label}
                      <svg className="w-3.5 h-3.5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </p>
                    <p className="text-white/60 text-xs leading-relaxed">{note}</p>
                  </>
                );
                const cls = "tilt-card block bg-white/5 border border-white/10 rounded-xl p-5 hover:bg-white/10 transition-colors";
                return external
                  ? <a key={href} href={href} className={cls}>{inner}</a>
                  : <Link key={href} href={href} className={cls}>{inner}</Link>;
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-14">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">What We Build</p>
            <h2 className="text-4xl font-black text-ink mb-4 tracking-tight">Analytics That Answers a Real Question</h2>
            <p className="text-slate-500 text-lg leading-relaxed">
              Most analytics projects fail because they start with the tool instead of the decision. We start by asking what you need to know and how often you need to know it, then build the smallest thing that answers it properly.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {capabilities.map(({ icon, title, desc, href, hrefLabel }) => (
              <div key={title} className="bg-white border border-gray-200 rounded-xl p-6 hover:border-gold/50 hover:shadow-md transition-all group flex flex-col">
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-gold/20 bg-gold/5 text-gold-dim"><ServiceIcon name={icon} /></div>
                <h3 className="text-ink font-bold mb-2 group-hover:text-gold-dim transition-colors">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed flex-1">{desc}</p>
                {href && (
                  <Link href={href} className="mt-4 inline-flex items-center gap-1.5 text-gold-dim font-semibold text-sm hover:text-gold-light transition-colors">
                    {hrefLabel}
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Who it is for */}
      <section className="py-20 bg-sand border-y border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Who It Is For</p>
            <h2 className="text-4xl font-black text-ink tracking-tight">Three Very Different Buyers</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {audiences.map(({ title, desc, href, hrefLabel }) => (
              <div key={title} className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col">
                <h3 className="text-ink font-bold mb-3">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed flex-1">{desc}</p>
                <Link href={href} className="mt-5 inline-flex items-center gap-1.5 text-gold-dim font-semibold text-sm hover:text-gold-light transition-colors">
                  {hrefLabel}
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How we work */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">How We Work</p>
            <h2 className="text-4xl font-black text-ink tracking-tight">No Surprises, No Retainer You Cannot Leave</h2>
          </div>
          <ol className="space-y-4">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-4 bg-sand border border-gray-200 rounded-xl p-5">
                <span className="w-8 h-8 rounded-full bg-navy text-white text-xs font-black flex items-center justify-center shrink-0">{i + 1}</span>
                <p className="text-slate-600 text-sm leading-relaxed pt-1.5">{step}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Where to start */}
      <section id="start" className="py-20 bg-sand border-t border-gray-200 scroll-mt-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Where to Start</p>
            <h2 className="text-4xl font-black text-ink tracking-tight">Pick the Smallest Useful Step</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {startingPoints.map(({ title, price, desc, href, cta, featured }) => (
              <div key={title} className={`bg-white rounded-2xl p-8 flex flex-col ${featured ? "border-2 border-gold" : "border border-gray-200"}`}>
                <h3 className="text-ink font-black text-lg mb-1">{title}</h3>
                <p className="text-2xl font-black text-ink mb-4">{price}</p>
                <p className="text-slate-500 text-sm mb-6 flex-1">{desc}</p>
                <Link
                  href={href}
                  className={`block text-center py-3 rounded-lg font-bold text-sm transition-opacity ${featured ? "gradient-gold text-white hover:opacity-90" : "border border-gray-300 text-ink font-semibold hover:bg-gray-50"}`}
                >
                  {cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-navy py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-black text-white mb-4">Not Sure What You Need Yet?</h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Tell us the question you keep trying to answer and cannot. We will tell you what it would take to answer it properly, even if that turns out to be less work than you expected.
          </p>
          <Link href="/contact" className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg gradient-gold text-white font-bold hover:opacity-90 transition-opacity">
            Talk to Us
          </Link>
        </div>
      </section>
    </>
  );
}
