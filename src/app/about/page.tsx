import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About Us",
  description: "Frontier Capital Signals provides AI-powered investment intelligence for Ghana, Nigeria, Kenya, Malawi, and Uganda. On-ground networks meet cutting-edge AI for frontier market investors.",
  alternates: { canonical: "https://frontiercapitalsignals.com/about" },
  keywords: ["Africa investment firm", "frontier market intelligence company", "Africa research firm", "emerging market advisory Africa", "invest in Africa company"],
  openGraph: { url: "https://frontiercapitalsignals.com/about", type: "website" },
};

const values = [
  { icon: "🎯", title: "Ground Truth", desc: "We combine AI-driven analysis with real on-ground intelligence from people who live and work in these markets. Data without context is noise." },
  { icon: "⚡", title: "Speed", desc: "Investment opportunities in frontier markets move fast. Our systems operate continuously so that by the time you read a signal, it's already been validated." },
  { icon: "🔒", title: "Integrity", desc: "We don't exaggerate risk or opportunity. We report what we find, with confidence scores and sources, so clients make better decisions." },
  { icon: "🌍", title: "Africa-First", desc: "We believe in the transformative potential of African markets — not as charity, but as the most compelling investment thesis of the next decade." },
];

export default function AboutPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">About Us</p>
            <h1 className="text-5xl font-black text-ink mb-5 tracking-tight">Built for Investors Who Take Africa Seriously</h1>
            <p className="text-slate-500 text-lg leading-relaxed">
              Frontier Capital Signals was founded on a simple observation: billions of dollars of investable capital never reach Africa&apos;s most dynamic economies — not because of a lack of opportunity, but because of a lack of reliable intelligence.
            </p>
          </div>
        </div>
      </section>

      {/* Mission */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
            <div>
              <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">Our Mission</p>
              <h2 className="text-4xl font-black text-ink mb-6 tracking-tight">Close the Intelligence Gap</h2>
              <div className="space-y-4 text-slate-500 leading-relaxed text-sm">
                <p>Ghana, Nigeria, Kenya, Malawi, and Uganda are home to some of the world&apos;s fastest-growing economies, youngest populations, and most undercapitalized sectors. Yet most global investors lack the tools to act on these markets with confidence.</p>
                <p>Information is fragmented across dozens of government portals, ministries, and local databases. Due diligence is expensive and requires trusted on-ground presence. Local intelligence — the kind that tells you which project is real and which counterparty is reliable — is nearly impossible to obtain remotely.</p>
                <p>We built Frontier Capital Signals to solve that problem. Our platform combines AI-powered data aggregation with an active network of on-ground partners who understand the texture of each market. The result is investment intelligence that is fast, verified, and actionable.</p>
              </div>
            </div>
            <div className="bg-sand border border-gray-200 rounded-2xl p-8">
              <div className="space-y-6">
                {[
                  { label: "Markets Covered", value: "5", note: "Ghana, Nigeria, Kenya, Malawi, Uganda" },
                  { label: "Data Sources Monitored", value: "50+", note: "Government portals, tender databases, sector registries" },
                  { label: "Intelligence Updates", value: "Daily", note: "New signals published every morning" },
                  { label: "Sectors Tracked", value: "12+", note: "Infrastructure, energy, mining, fintech, agri, and more" },
                ].map(({ label, value, note }) => (
                  <div key={label} className="flex items-start gap-5 pb-5 border-b border-gray-200 last:border-0 last:pb-0">
                    <div className="text-3xl font-black text-gradient-gold min-w-[70px] tabular-nums">{value}</div>
                    <div>
                      <p className="text-ink font-semibold text-sm">{label}</p>
                      <p className="text-slate-400 text-xs mt-0.5">{note}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-20 bg-sand">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">What Drives Us</p>
            <h2 className="text-4xl font-black text-ink tracking-tight">Our Principles</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {values.map(({ icon, title, desc }) => (
              <div key={title} className="bg-white border border-gray-200 rounded-xl p-6 hover:border-gold/40 hover:shadow-sm transition-all">
                <div className="text-3xl mb-4">{icon}</div>
                <h3 className="text-ink font-bold mb-2">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">Our Capabilities</p>
            <h2 className="text-4xl font-black text-ink tracking-tight">How We Deliver Intelligence</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { title: "Intelligence & AI", desc: "Our AI continuously monitors hundreds of data sources across all five markets — government portals, tender databases, news feeds, regulatory filings, and proprietary on-ground reports." },
              { title: "On-Ground Networks", desc: "We maintain active relationships with local business communities, government departments, investment agencies, and sector associations across all five markets." },
              { title: "Research & Analysis", desc: "Senior analysts produce investment memos, risk assessments, and opportunity briefs that synthesize AI-generated signals with expert judgment and local market knowledge." },
            ].map(({ title, desc }) => (
              <div key={title} className="bg-sand border border-gray-200 rounded-xl p-6">
                <div className="w-10 h-10 rounded-lg bg-navy flex items-center justify-center mb-4">
                  <span className="text-white font-black text-xs">FCS</span>
                </div>
                <h3 className="text-ink font-bold mb-3">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-navy py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-black text-white mb-3">Ready to See What We See?</h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto text-sm">
            Request a sample intelligence brief for any of our five focus markets. No commitment required.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/contact" className="px-8 py-3.5 rounded-lg gradient-gold text-white font-bold hover:opacity-90 transition-opacity">Request Sample Brief</Link>
            <Link href="/intelligence" className="px-8 py-3.5 rounded-lg border border-white/20 text-white/80 font-semibold hover:bg-white/10 transition-colors">Browse Free Intelligence</Link>
          </div>
        </div>
      </section>
    </>
  );
}
