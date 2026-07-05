import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Services",
  description: "AI-powered investment intelligence, due diligence, market entry strategy, field research, and process optimization for investors in Ghana, Nigeria, Kenya, Malawi, and Uganda.",
  alternates: { canonical: "https://frontiercapitalsignals.com/services" },
  keywords: ["Africa investment services", "Africa due diligence", "market entry Africa", "Africa deal origination", "frontier market consulting", "Africa field research", "Ghana Nigeria Kenya investment advisory"],
  openGraph: { url: "https://frontiercapitalsignals.com/services", type: "website" },
};

const services = [
  {
    id: "intelligence", icon: "🧠", title: "Daily Investment Intelligence", tagline: "Never miss an opportunity",
    desc: "Our AI continuously monitors government procurement portals, tender notices, energy project filings, mining concession databases, startup registrations, and regulatory announcements across all five markets. Every morning you receive a curated digest of actionable signals ranked by sector relevance and opportunity score.",
    deliverables: ["Daily intelligence brief (email or dashboard)", "Opportunity scoring (1-100 by sector and country)", "Investment memo templates for top-ranked opportunities", "Weekly sector deep-dives", "Regulatory change alerts"],
    badge: "Most Popular",
  },
  {
    id: "due-diligence", icon: "🔍", title: "Due Diligence & Risk Assessment", tagline: "Verify before you commit",
    desc: "We deploy on-ground researchers to verify what remote analysts cannot: land title integrity, counterparty reputation, local community dynamics, infrastructure access, and regulatory standing. Our risk assessments combine AI-powered data analysis with direct field intelligence.",
    deliverables: ["Full counterparty background check", "Land and property title verification", "Regulatory compliance review", "Local community and stakeholder mapping", "Structured risk matrix with mitigation recommendations"],
  },
  {
    id: "market-entry", icon: "🗺️", title: "Market Entry Strategy", tagline: "Enter with confidence",
    desc: "Every African market has its own legal framework, regulatory culture, informal norms, and relationship networks. We build you a country-specific playbook covering everything from business registration and tax structuring to sector-specific licensing and optimal operating structures.",
    deliverables: ["Country-specific legal and tax structure analysis", "Sector licensing requirements and timelines", "Operating cost benchmarks", "Competitor and incumbent mapping", "Recommended local partners and advisors"],
  },
  {
    id: "deal-origination", icon: "🤝", title: "Deal Origination & Pipeline", tagline: "Access deals before they go public",
    desc: "Our network of government contacts, sectoral associations, and local business leaders gives us access to off-market deals that never appear on international databases. We match investor mandates with real opportunities across infrastructure, energy, agriculture, real estate, and technology.",
    deliverables: ["Curated deal pipeline matched to your mandate", "Direct introductions to opportunity owners", "Pre-screened for regulatory feasibility", "Preliminary financial and operational assessment", "Ongoing pipeline refresh as new deals emerge"],
  },
  {
    id: "field-research", icon: "📊", title: "Market Surveys & Field Research", tagline: "Real data from real people",
    desc: "We conduct primary research using in-country research teams who understand local context, language, and dynamics. Whether you need consumer sentiment surveys, sector feasibility studies, price discovery research, or competitive intelligence, our teams can reach respondents that external firms can't.",
    deliverables: ["Custom survey design and questionnaire development", "In-country data collection (urban and rural)", "Focus groups and key informant interviews", "Competitive pricing and market share analysis", "Full research report with executive summary"],
  },
  {
    id: "regulatory", icon: "📋", title: "Regulatory Navigation & Government Relations", tagline: "Know the rules before you play",
    desc: "Regulatory environments across our five markets are dynamic and relationship-driven. We help investors navigate licensing processes, engage the right government stakeholders, interpret new policy changes, and maintain compliance as regulations evolve.",
    deliverables: ["Sector-specific licensing pathway mapping", "Government stakeholder identification and engagement strategy", "Policy monitoring and regulatory change alerts", "Compliance checklist and documentation support", "Representation at key government engagement points"],
  },
  {
    id: "partner-matching", icon: "🔗", title: "Local Partner Matching & Vetting", tagline: "Find partners you can trust",
    desc: "A credible local partner is often the difference between market access and market failure in Africa. We identify, vet, and introduce investors to local partners across legal, operational, distribution, and sector-specific domains.",
    deliverables: ["Partner candidate identification (3-5 options)", "Background and reputation verification", "Financial capacity assessment", "Structured introduction and negotiation support", "Partnership agreement framework"],
  },
  {
    id: "infrastructure", icon: "🏗️", title: "Infrastructure & PPP Opportunity Tracking", tagline: "Get in before the crowd",
    desc: "Government-backed infrastructure projects and public-private partnerships represent billions in annual deployment opportunity across our focus markets. We track tender issuances, project financings, concession awards, and pre-qualification windows in real time.",
    deliverables: ["Live infrastructure tender tracker", "PPP opportunity scoring", "Pre-qualification support and documentation", "Project finance structure analysis", "Government relationship support for bid preparation"],
  },
  {
    id: "process-optimization", icon: "⚙️", title: "Process Optimization", tagline: "Extract more from what you have",
    desc: "For businesses already operating in our focus markets, we provide operational consulting to improve efficiency, reduce friction costs, and optimize supply chains. Our on-ground teams identify process bottlenecks that corporate headquarters rarely see from the outside.",
    deliverables: ["Operational audit and bottleneck identification", "Supply chain mapping and optimization", "Cost benchmarking against local comparables", "Staff productivity and HR structure review", "Implementation roadmap with measurable KPIs"],
  },
];

export default function ServicesPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Our Services</p>
            <h1 className="text-5xl font-black text-ink mb-5 tracking-tight">The Full Intelligence Stack for African Markets</h1>
            <p className="text-slate-500 text-lg">
              Whether you&apos;re scanning for opportunities, entering a new market, deploying capital, or already operational, we have a service designed for your stage.
            </p>
          </div>
        </div>
      </section>

      {/* Services */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
          {services.map(({ id, icon, title, tagline, desc, deliverables, badge }) => (
            <div key={id} id={id} className="bg-white border border-gray-200 rounded-2xl p-8 scroll-mt-20 hover:border-gold/40 hover:shadow-md transition-all">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                  <div className="flex items-start gap-4 mb-4">
                    <span className="text-4xl">{icon}</span>
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-xl font-black text-ink">{title}</h2>
                        {badge && (
                          <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full gradient-gold text-white">{badge}</span>
                        )}
                      </div>
                      <p className="text-gold-dim text-sm font-semibold">{tagline}</p>
                    </div>
                  </div>
                  <p className="text-slate-500 leading-relaxed text-sm">{desc}</p>
                </div>
                <div>
                  <p className="text-slate-600 text-xs font-semibold tracking-widest uppercase mb-3">Deliverables</p>
                  <ul className="space-y-2">
                    {deliverables.map((d) => (
                      <li key={d} className="flex items-start gap-2 text-sm text-slate-600">
                        <svg className="w-4 h-4 text-gold mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="bg-navy py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-black text-white mb-4">Not Sure Where to Start?</h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Tell us your investment mandate or operational challenge and we&apos;ll recommend the right combination of services.
          </p>
          <Link href="/contact" className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg gradient-gold text-white font-bold hover:opacity-90 transition-opacity">
            Book a Free Consultation
          </Link>
        </div>
      </section>
    </>
  );
}
