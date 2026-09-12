import Link from "next/link";
import PostCard from "@/components/PostCard";
import { getLatestPosts } from "@/lib/posts";

const focusMarkets = ["Ghana", "Nigeria", "Kenya", "Malawi", "Uganda"];

const services = [
  { icon: "🧠", title: "Daily Investment Intelligence", desc: "AI-assisted summaries of public reporting, with links to the original sources." },
  { icon: "🔍", title: "Due Diligence Support", desc: "On-ground verification, risk assessments, and local intelligence that remote analysts cannot access." },
  { icon: "🤝", title: "Deal Origination", desc: "Access off-market opportunities through our established networks across five high-growth African economies." },
  { icon: "🗺️", title: "Market Entry Strategy", desc: "Country-specific roadmaps covering regulatory requirements, tax structures, local partner matching, and land access." },
  { icon: "📊", title: "Market Surveys & Field Research", desc: "Primary research with real respondents in-market. Consumer sentiment, sector mapping, competitive intelligence." },
  { icon: "⚙️", title: "Process Optimization", desc: "Operational consulting to help businesses in African markets reduce costs and delays." },
];

const sectors = [
  { name: "Infrastructure & PPP", countries: "GH · NG · KE · UG" },
  { name: "Energy & Renewables", countries: "GH · KE · MWI" },
  { name: "Fintech & Digital Finance", countries: "NG · KE · GH" },
  { name: "Agribusiness & Export", countries: "GH · UG · MWI" },
  { name: "Mining & Extractives", countries: "GH · MWI · UG" },
  { name: "Real Estate", countries: "NG · KE · GH" },
];

export default function HomePage() {
  const posts = getLatestPosts(3);

  return (
    <>
      {/* Hero — dark, dramatic */}
      <section className="relative overflow-hidden bg-navy min-h-[88vh] flex items-center">
        {/* Subtle grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "64px 64px" }}
        />
        {/* Gold glow */}
        <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-gold/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 w-full">
          <div className="max-w-3xl">
            {/* Live badge */}
            <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-white/10 border border-white/20 mb-8">
              <span className="w-2 h-2 rounded-full bg-gold animate-pulse" />
              <span className="text-white/80 text-xs font-semibold tracking-widest uppercase">Live Market Intelligence</span>
            </div>

            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-black text-white leading-[1.05] mb-6 tracking-tight">
              African Markets.<br />
              <span className="text-gradient-gold">Clearer Context.</span>
            </h1>

            <p className="text-white/70 text-lg sm:text-xl leading-relaxed mb-10 max-w-xl">
              Daily news summaries and research support for Ghana, Nigeria, Kenya, Malawi, and Uganda. Follow the sources, understand the context, and decide what to investigate next.
            </p>

            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                href="/intelligence"
                className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity shadow-lg shadow-gold/20"
              >
                Read Today&apos;s Intelligence
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
              <Link
                href="/services"
                className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-lg border border-white/20 text-white/80 font-semibold text-sm hover:bg-white/10 transition-colors"
              >
                Explore Services
              </Link>
            </div>
          </div>
        </div>
      </section>

      <nav className="bg-sand border-b border-gray-200" aria-label="Explore our focus markets">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-wrap items-center gap-x-8 gap-y-4">
          <p className="text-slate-600 text-xs uppercase tracking-widest font-semibold">Five focus markets</p>
          {focusMarkets.map((market) => (
            <Link key={market} href={`/resources#${market.toLowerCase()}`} className="text-ink font-semibold underline underline-offset-4 decoration-gold/50 hover:decoration-gold">
              {market}
            </Link>
          ))}
        </div>
      </nav>

      {/* Services — white */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-14">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">What We Do</p>
            <h2 className="text-4xl font-black text-ink mb-4 tracking-tight">Intelligence You Can Act On</h2>
            <p className="text-slate-500 text-lg leading-relaxed">
              From daily AI-curated signals to full-scale market entry support, we provide the intelligence layer that turns African markets from opaque to legible.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {services.map(({ icon, title, desc }) => (
              <div key={title} className="bg-white border border-gray-200 rounded-xl p-6 hover:border-gold/50 hover:shadow-md transition-all group">
                <div className="text-3xl mb-4">{icon}</div>
                <h3 className="text-ink font-bold mb-2 group-hover:text-gold-dim transition-colors">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-10">
            <Link href="/services" className="inline-flex items-center gap-2 text-gold-dim font-semibold hover:text-gold-light transition-colors text-sm">
              View all services
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* Signals teaser — navy, links out to the separate Cloudflare Worker at /signals */}
      <section className="py-24 bg-navy relative overflow-hidden">
        <div className="absolute top-0 right-0 w-[500px] h-[300px] bg-gold/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/20 mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
                <span className="text-white/80 text-xs font-semibold tracking-widest uppercase">New · Quantitative Tool</span>
              </div>
              <h2 className="text-4xl font-black text-white mb-5 tracking-tight">Frontier Capital Signals</h2>
              <p className="text-white/70 text-lg leading-relaxed mb-4 max-w-xl">
                Hourly confluence screens across 290 US equities and 150+ cryptocurrencies. Up to 16 independent technical and valuation techniques, from RSI and MACD to Wall Street price targets, reversal detection and multi-year seasonal analogs, must agree before a setup ranks. A setup that cannot clear its own historical no-skill baseline is withheld rather than published.
              </p>
              <p className="text-white/40 text-sm mb-8 max-w-xl">
                Mechanical technical analysis, not investment advice. Markets carry real risk of loss.
              </p>
              <a
                href="/signals"
                className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity shadow-lg shadow-gold/20"
              >
                View Live Signals
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </a>
            </div>
            <div className="tilt-stage grid grid-cols-2 gap-3">
              {[
                { label: "Assets Screened", value: "440+" },
                { label: "Techniques", value: "16" },
                { label: "Refresh Rate", value: "Hourly" },
                { label: "Coverage", value: "Crypto + US Equities" },
              ].map(({ label, value }) => (
                <div key={label} className="tilt-card bg-white/5 border border-white/10 rounded-xl p-5">
                  <p className="text-2xl font-black text-gradient-gold">{value}</p>
                  <p className="text-white/60 text-xs font-semibold mt-1">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Opportunity scores — sand */}
      <section className="py-24 bg-sand">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Market Coverage</p>
              <h2 className="text-4xl font-black text-ink mb-5 tracking-tight">Sectors Worth Following</h2>
              <p className="text-slate-600 leading-relaxed mb-8">
                Infrastructure, energy, finance, and the businesses around them. Use our reporting as a starting point for research, then check the underlying sources and local conditions.
              </p>
              <Link href="/intelligence" className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-navy text-white font-semibold text-sm hover:bg-navy-700 transition-colors">
                See Full Intelligence Feed
              </Link>
            </div>
            <div className="tilt-stage space-y-3">
              {sectors.map(({ name, countries }) => (
                <div key={name} className="tilt-card bg-white border border-gray-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <div>
                      <span className="text-ink font-semibold text-sm">{name}</span>
                      <span className="ml-2 text-slate-600 text-xs">{countries}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Latest Intelligence — white */}
      {posts.length > 0 && (
        <section className="py-24 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-end justify-between mb-12">
              <div>
                <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Latest Intelligence</p>
                <h2 className="text-4xl font-black text-ink tracking-tight">Today&apos;s Market Signals</h2>
              </div>
              <Link href="/intelligence" className="text-gold text-sm font-semibold hover:text-gold-light hidden sm:flex items-center gap-1 transition-colors">
                View all
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {posts.map((post) => <PostCard key={post.slug} post={post} />)}
            </div>
          </div>
        </section>
      )}

      {/* CTA — dark */}
      <section className="py-24 bg-navy relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-gold/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-4">Why Now</p>
          <h2 className="text-4xl sm:text-5xl font-black text-white mb-6 max-w-3xl mx-auto leading-tight tracking-tight">
            Understand Your Next Market
          </h2>
          <p className="text-white/60 text-lg max-w-xl mx-auto mb-10">
            Tell us which market you are exploring and what you need to understand. We can discuss the research and local support your project needs.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/contact" className="px-8 py-3.5 rounded-lg gradient-gold text-white font-bold hover:opacity-90 transition-opacity shadow-lg shadow-gold/20">
              Request a Market Briefing
            </Link>
            <Link href="/resources" className="px-8 py-3.5 rounded-lg border border-white/20 text-white/80 font-semibold hover:bg-white/10 transition-colors">
              Investor Resources
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
