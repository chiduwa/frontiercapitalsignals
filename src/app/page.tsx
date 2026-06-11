import Link from "next/link";
import PostCard from "@/components/PostCard";
import { getLatestPosts } from "@/lib/posts";

const stats = [
  { label: "Combined GDP", value: "$1.2T", note: "Ghana · Nigeria · Kenya · Malawi · Uganda" },
  { label: "FDI Growth Forecast", value: "+18%", note: "Sub-Saharan Africa 2025" },
  { label: "Mobile Money Users", value: "300M+", note: "Across focus markets" },
  { label: "Infrastructure Gap", value: "$100B+", note: "Annual investment opportunity" },
];

const services = [
  {
    icon: "🧠",
    title: "Daily Investment Intelligence",
    desc: "AI-curated signals from government databases, tender portals, and on-ground sources — delivered every morning.",
  },
  {
    icon: "🔍",
    title: "Due Diligence Support",
    desc: "On-ground verification, risk assessments, and local intelligence that remote analysts cannot access.",
  },
  {
    icon: "🤝",
    title: "Deal Origination",
    desc: "Access off-market opportunities through our established networks across five high-growth African economies.",
  },
  {
    icon: "🗺️",
    title: "Market Entry Strategy",
    desc: "Country-specific roadmaps covering regulatory requirements, tax structures, local partner matching, and land access.",
  },
  {
    icon: "📊",
    title: "Market Surveys & Field Research",
    desc: "Primary research with real respondents in-market. Consumer sentiment, sector mapping, competitive intelligence.",
  },
  {
    icon: "⚙️",
    title: "Process Optimization",
    desc: "Operational consulting for businesses already active in African markets — reduce costs, cut delays, improve margins.",
  },
];

const sectors = [
  { name: "Infrastructure & PPP", countries: "GH · NG · KE · UG", score: 92 },
  { name: "Energy & Renewables", countries: "GH · KE · MWI", score: 89 },
  { name: "Fintech & Digital Finance", countries: "NG · KE · GH", score: 88 },
  { name: "Agribusiness & Export", countries: "GH · UG · MWI", score: 85 },
  { name: "Mining & Extractives", countries: "GH · MWI · UG", score: 80 },
  { name: "Real Estate", countries: "NG · KE · GH", score: 76 },
];

export default function HomePage() {
  const posts = getLatestPosts(3);

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden bg-navy min-h-[92vh] flex items-center">
        <div
          className="absolute inset-0 opacity-5"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, #c9962a 1px, transparent 0)",
            backgroundSize: "40px 40px",
          }}
        />
        <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-gold/5 to-transparent pointer-events-none" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 w-full">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-gold/40 bg-gold/10 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
              <span className="text-gold text-xs font-semibold tracking-wide uppercase">Live Market Intelligence</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight mb-6">
              Africa&apos;s Most{" "}
              <span className="text-gradient-gold">Invisible Opportunities</span>{" "}
              Made Visible
            </h1>

            <p className="text-slate-300 text-lg sm:text-xl leading-relaxed mb-8 max-w-2xl">
              Frontier Capital Signals uses AI and on-ground intelligence networks to surface investment opportunities in Ghana, Nigeria, Kenya, Malawi, and Uganda before they reach the global market.
            </p>

            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                href="/intelligence"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg gradient-gold text-navy font-bold text-sm hover:opacity-90 transition-opacity"
              >
                View Today&apos;s Intelligence
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
              <Link
                href="/services"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg border border-slate-600 text-slate-300 font-semibold text-sm hover:border-gold hover:text-gold transition-colors"
              >
                Explore Our Services
              </Link>
            </div>
          </div>

          <div className="mt-16 grid grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map(({ label, value, note }) => (
              <div key={label} className="bg-navy-800/80 backdrop-blur border border-navy-600 rounded-xl p-4">
                <p className="text-2xl font-black text-gradient-gold">{value}</p>
                <p className="text-white text-sm font-semibold mt-1">{label}</p>
                <p className="text-slate-500 text-xs mt-0.5">{note}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Services */}
      <section className="py-20 bg-navy-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">What We Do</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">Intelligence You Can Act On</h2>
            <p className="text-slate-400 text-lg max-w-2xl mx-auto">
              From daily AI-curated signals to full-scale market entry support, we provide the intelligence layer that turns African markets from opaque to legible.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {services.map(({ icon, title, desc }) => (
              <div key={title} className="bg-navy border border-navy-600 rounded-xl p-6 hover:border-gold/40 transition-colors group">
                <div className="text-3xl mb-4">{icon}</div>
                <h3 className="text-white font-bold mb-2 group-hover:text-gold-light transition-colors">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link href="/services" className="inline-flex items-center gap-2 text-gold font-semibold hover:text-gold-light transition-colors">
              View all services
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* Opportunity scores */}
      <section className="py-20 bg-navy">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">Opportunity Radar</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">Where Capital Is Flowing</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Our AI analyzes government procurement portals, tender notices, policy announcements, and on-ground reports to score opportunity intensity across key sectors. Updated weekly.
              </p>
              <Link
                href="/intelligence"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg gradient-gold text-navy font-bold text-sm hover:opacity-90 transition-opacity"
              >
                See Full Intelligence Feed
              </Link>
            </div>
            <div className="space-y-3">
              {sectors.map(({ name, countries, score }) => (
                <div key={name} className="bg-navy-800 border border-navy-600 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="text-white font-semibold text-sm">{name}</span>
                      <span className="ml-2 text-slate-500 text-xs">{countries}</span>
                    </div>
                    <span className="text-gold font-bold text-sm">{score}/100</span>
                  </div>
                  <div className="h-1.5 bg-navy-700 rounded-full overflow-hidden">
                    <div className="h-full gradient-gold rounded-full" style={{ width: `${score}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Latest Intelligence */}
      {posts.length > 0 && (
        <section className="py-20 bg-navy-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-end justify-between mb-10">
              <div>
                <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">Latest Intelligence</p>
                <h2 className="text-3xl font-black text-white">Today&apos;s Market Signals</h2>
              </div>
              <Link href="/intelligence" className="text-gold text-sm font-semibold hover:text-gold-light hidden sm:flex items-center gap-1">
                View all
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {posts.map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA */}
      <section className="py-24 bg-navy relative overflow-hidden">
        <div className="absolute inset-0 opacity-10 bg-gradient-to-br from-gold via-transparent to-transparent pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-4">Why Now</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white mb-6 max-w-3xl mx-auto">
            Billions in Capital Are Bypassing Africa&apos;s Fastest-Growing Economies
          </h2>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto mb-4">
            Not because the opportunities don&apos;t exist. Because the intelligence infrastructure didn&apos;t. Until now.
          </p>
          <p className="text-slate-300 text-lg max-w-2xl mx-auto mb-10">
            We have connections on the ground in Ghana, Nigeria, Kenya, Malawi, and Uganda. Our AI never stops watching.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/contact" className="px-8 py-3 rounded-lg gradient-gold text-navy font-bold hover:opacity-90 transition-opacity">
              Request a Market Briefing
            </Link>
            <Link href="/resources" className="px-8 py-3 rounded-lg border border-slate-600 text-slate-300 font-semibold hover:border-gold hover:text-gold transition-colors">
              Explore Investor Resources
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
