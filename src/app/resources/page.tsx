import type { Metadata } from "next";
import Link from "next/link";
import { GDPChart, FDIChart, BusinessEnvironmentChart, SectorRadarChart } from "@/components/MarketCharts";

export const metadata: Metadata = {
  title: "Investor Resources",
  description: "Country-by-country investor resource guides for Ghana, Nigeria, Kenya, Malawi, and Uganda. Official government portals, investment agencies, regulatory bodies, and market data charts.",
  alternates: { canonical: "https://frontiercapitalsignals.com/resources" },
  keywords: ["how to invest in Ghana", "how to invest in Nigeria", "how to invest in Kenya", "how to invest in Malawi", "how to invest in Uganda", "Africa business registration", "GIPC Ghana", "NIPC Nigeria", "KenInvest Kenya", "MITC Malawi", "Uganda Investment Authority", "Africa GDP data", "Africa FDI statistics"],
  openGraph: { url: "https://frontiercapitalsignals.com/resources", type: "website" },
};

const countries = [
  {
    id: "ghana", name: "Ghana", flag: "🇬🇭", tagline: "Gateway to West Africa",
    highlight: "Stable democracy, strong investor protections, major oil and gas sector, growing tech hub — the Silicon Savannah of West Africa.",
    resources: [
      { label: "Ghana Investment Promotion Centre (GIPC)", url: "https://gipc.gov.gh", desc: "Primary investment promotion authority. Register investments, find incentives." },
      { label: "Registrar General's Department", url: "https://rgd.gov.gh", desc: "Company registration, business name registration, intellectual property." },
      { label: "Ghana Revenue Authority (GRA)", url: "https://gra.gov.gh", desc: "Tax registration, tax incentives, TINs, customs." },
      { label: "Bank of Ghana", url: "https://bog.gov.gh", desc: "Central bank, forex regulations, licensing for financial institutions." },
      { label: "Ministry of Trade and Industry", url: "https://moti.gov.gh", desc: "Trade policy, industrial licensing, sector-specific investment info." },
      { label: "Public Procurement Authority", url: "https://ppa.gov.gh", desc: "Government tender notices and procurement opportunities." },
      { label: "Ghana Free Zones Authority", url: "https://gfza.gov.gh", desc: "Free zone designation and incentives for export-oriented investments." },
    ],
  },
  {
    id: "nigeria", name: "Nigeria", flag: "🇳🇬", tagline: "Africa's Largest Economy",
    highlight: "Largest economy by GDP, 220M+ population, dominant fintech ecosystem, major oil producer with growing diversification push.",
    resources: [
      { label: "Nigerian Investment Promotion Commission (NIPC)", url: "https://nipc.gov.ng", desc: "Investment registration, incentives, one-stop investment shop." },
      { label: "Corporate Affairs Commission (CAC)", url: "https://www.cac.gov.ng", desc: "Business registration — companies, partnerships, NGOs." },
      { label: "Federal Inland Revenue Service (FIRS)", url: "https://firs.gov.ng", desc: "Federal tax administration, TINs, tax clearance certificates." },
      { label: "Central Bank of Nigeria (CBN)", url: "https://cbn.gov.ng", desc: "Monetary policy, forex regulations, financial sector licensing." },
      { label: "Nigeria Export-Import Bank (NEXIM)", url: "https://www.neximbank.com.ng", desc: "Trade finance and export development support." },
      { label: "Infrastructure Concession Regulatory Commission", url: "https://www.icrc.gov.ng", desc: "PPP project registry, concession opportunities." },
      { label: "Securities and Exchange Commission (SEC)", url: "https://sec.gov.ng", desc: "Capital markets regulation, investment fund registration." },
    ],
  },
  {
    id: "kenya", name: "Kenya", flag: "🇰🇪", tagline: "East Africa's Tech Capital",
    highlight: "Regional financial hub, home to M-Pesa, strong startup ecosystem, major infrastructure investment under Vision 2030, gateway to East Africa.",
    resources: [
      { label: "Kenya Investment Authority (KenInvest)", url: "https://www.investmentkenya.com", desc: "Investment registration, facilitation, and aftercare services." },
      { label: "Business Registration Service", url: "https://brs.go.ke", desc: "Company registration, business name search, intellectual property." },
      { label: "Kenya Revenue Authority (KRA)", url: "https://www.kra.go.ke", desc: "Tax registration, iTax portal, customs, import/export permits." },
      { label: "Central Bank of Kenya (CBK)", url: "https://www.centralbank.go.ke", desc: "Monetary policy, foreign exchange, banking sector licensing." },
      { label: "Kenya Bureau of Standards (KEBS)", url: "https://www.kebs.org", desc: "Product standards, certification, import clearance." },
      { label: "Public Procurement Regulatory Authority", url: "https://ppra.go.ke", desc: "Government tender opportunities and procurement notices." },
      { label: "Capital Markets Authority (CMA Kenya)", url: "https://www.cma.or.ke", desc: "Securities regulation, fund management licensing." },
    ],
  },
  {
    id: "malawi", name: "Malawi", flag: "🇲🇼", tagline: "The Warm Heart of Africa",
    highlight: "Emerging frontier market with major opportunities in agriculture, mining, and energy. Low competition from international investors — high upside potential.",
    resources: [
      { label: "Malawi Investment and Trade Centre (MITC)", url: "https://mitc.mw", desc: "Primary investment promotion body. Facilitation, incentives, sector guides." },
      { label: "Registrar of Companies (Malawi)", url: "https://obrm.gov.mw", desc: "Company registration, business licensing." },
      { label: "Malawi Revenue Authority (MRA)", url: "https://mra.mw", desc: "Tax registration, tax incentives for qualifying investments." },
      { label: "Reserve Bank of Malawi", url: "https://www.rbm.mw", desc: "Monetary policy, forex, financial sector regulation." },
      { label: "Ministry of Natural Resources, Energy and Mining", url: "https://www.mines.gov.mw", desc: "Mining concessions, energy projects, natural resource licensing." },
      { label: "Malawi Energy Regulatory Authority (MERA)", url: "https://www.meramalawi.mw", desc: "Energy sector regulation, licenses for energy projects." },
    ],
  },
  {
    id: "uganda", name: "Uganda", flag: "🇺🇬", tagline: "Pearl of Africa, Rising Economy",
    highlight: "Rapidly expanding oil sector (first production 2025), strong agriculture base, young population, major infrastructure development underway.",
    resources: [
      { label: "Uganda Investment Authority (UIA)", url: "https://www.ugandainvest.go.ug", desc: "Investment registration, facilitation, incentives, sector briefs." },
      { label: "Uganda Registration Services Bureau (URSB)", url: "https://www.ursb.go.ug", desc: "Business registration, intellectual property, civil registration." },
      { label: "Uganda Revenue Authority (URA)", url: "https://www.ura.go.ug", desc: "Tax registration, tax clearance, customs and excise." },
      { label: "Bank of Uganda", url: "https://www.bou.or.ug", desc: "Monetary policy, foreign exchange, commercial banking licenses." },
      { label: "Petroleum Authority of Uganda (PAU)", url: "https://pau.go.ug", desc: "Oil and gas sector regulation, upstream licensing." },
      { label: "Uganda National Roads Authority (UNRA)", url: "https://www.unra.go.ug", desc: "Road infrastructure projects, PPP opportunities." },
      { label: "Public Procurement and Disposal of Public Assets (PPDA)", url: "https://www.ppda.go.ug", desc: "Government tenders, procurement notices." },
    ],
  },
];

export default function ResourcesPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Investor Resources</p>
            <h1 className="text-5xl font-black text-ink mb-4 tracking-tight">Your African Market Toolkit</h1>
            <p className="text-slate-500 text-lg">
              Official government portals, investment agencies, and key contacts for each of our five focus markets. Verified and curated for international investors.
            </p>
          </div>
        </div>
      </section>

      {/* Charts */}
      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Market Data</p>
            <h2 className="text-3xl font-black text-ink tracking-tight">The Numbers That Matter</h2>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[
              { title: "GDP Growth Rate (%)", note: "Annual GDP growth 2020-2024. Source: World Bank.", Chart: GDPChart },
              { title: "FDI Inflows (USD Billion)", note: "Foreign direct investment inflows 2023. Source: UNCTAD.", Chart: FDIChart },
              { title: "Business Environment Indicators", note: "Ease of doing business scores (100 = best). Source: World Bank.", Chart: BusinessEnvironmentChart },
              { title: "Sector Opportunity Scores", note: "FCS AI-generated opportunity intensity across key sectors. Updated weekly.", Chart: SectorRadarChart },
            ].map(({ title, note, Chart }) => (
              <div key={title} className="bg-white border border-gray-200 rounded-2xl p-6 hover:shadow-sm transition-shadow">
                <h3 className="text-ink font-bold mb-1 text-sm">{title}</h3>
                <p className="text-slate-600 text-xs mb-5">{note}</p>
                <Chart />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Country resources */}
      <section className="py-16 bg-sand">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">By Country</p>
            <h2 className="text-3xl font-black text-ink tracking-tight">Official Investment Resources</h2>
          </div>

          {/* Country nav */}
          <div className="flex flex-wrap gap-2 mb-12">
            {countries.map(({ id, name, flag }) => (
              <a key={id} href={`#${id}`} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-gray-200 text-sm font-semibold text-slate-600 hover:border-navy hover:text-navy transition-colors">
                <span>{flag}</span> {name}
              </a>
            ))}
          </div>

          <div className="space-y-14">
            {countries.map(({ id, name, flag, tagline, highlight, resources }) => (
              <div key={id} id={id} className="scroll-mt-20">
                <div className="flex items-center gap-4 mb-2">
                  <span className="text-4xl">{flag}</span>
                  <div>
                    <h2 className="text-2xl font-black text-ink">{name}</h2>
                    <p className="text-gold-dim text-sm font-semibold">{tagline}</p>
                  </div>
                </div>
                <p className="text-slate-500 text-sm mb-6 max-w-3xl leading-relaxed">{highlight}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {resources.map(({ label, url, desc }) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                      className="bg-white border border-gray-200 rounded-xl p-4 hover:border-gold/50 hover:shadow-md transition-all group">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className="text-ink text-sm font-semibold group-hover:text-gold-dim transition-colors leading-snug">{label}</h3>
                        <svg className="w-4 h-4 text-gray-300 group-hover:text-gold shrink-0 mt-0.5 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </div>
                      <p className="text-slate-600 text-xs leading-relaxed">{desc}</p>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-navy py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-2xl font-black text-white mb-3">Need Deeper Guidance?</h2>
          <p className="text-white/60 mb-6 max-w-xl mx-auto text-sm">
            Our team has on-ground relationships with investment agencies, regulators, and sector bodies across all five markets.
          </p>
          <Link href="/contact" className="inline-flex items-center gap-2 px-6 py-3 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity">
            Talk to Our Team
          </Link>
        </div>
      </section>
    </>
  );
}
