import type { Metadata } from "next";
import Link from "next/link";
import ExchangeDirectory from "@/components/ExchangeDirectory";
import { exchanges, listingCount, allListings, DATA_AS_OF } from "@/lib/exchanges";

export const metadata: Metadata = {
  title: "African Stock Exchanges",
  description:
    "Stock exchanges of Ghana, Nigeria, Kenya, Malawi and Uganda — GSE, NGX, NSE, MSE and USE. Share prices in local currency and US dollars, market capitalisation, regulators, depositories, settlement cycles, trading hours, indices, foreign investor access, and the full register of listed companies by sector.",
  alternates: { canonical: "https://frontiercapitalsignals.com/exchanges" },
  keywords: [
    "African stock exchanges",
    "Ghana Stock Exchange listed companies",
    "GSE Composite Index",
    "Nigerian Exchange NGX listed companies",
    "NGX All-Share Index",
    "Nairobi Securities Exchange listed companies",
    "NSE Kenya NASI",
    "Malawi Stock Exchange listed companies",
    "Uganda Securities Exchange listed companies",
    "how to buy African stocks",
    "frontier market equities Africa",
    "African stock tickers",
  ],
  openGraph: { url: "https://frontiercapitalsignals.com/exchanges", type: "website" },
};

const totalListings = allListings().length;
const totalIndices = exchanges.reduce((n, e) => n + e.indices.length, 0);

export default function ExchangesPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">
              Capital Markets
            </p>
            <h1 className="text-5xl font-black text-ink mb-4 tracking-tight">
              African Stock Exchanges
            </h1>
            <p className="text-slate-500 text-lg leading-relaxed">
              Every regulated equity market across our five focus countries — how each one is
              structured, who regulates it, how trades settle, what foreign investors are permitted
              to do, and every company on the board, priced in local currency and US dollars.
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
            <Stat value="5" label="Exchanges" />
            <Stat value={String(totalListings)} label="Listed securities" />
            <Stat value={String(totalIndices)} label="Index series" />
            <Stat value={DATA_AS_OF} label="Register verified" />
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-3xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">
              At a Glance
            </p>
            <h2 className="text-3xl font-black text-ink tracking-tight mb-3">
              The Five Markets Side by Side
            </h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              These markets differ by roughly two orders of magnitude in size. Nigeria&apos;s register
              alone matches the other four combined; Malawi lists seventeen companies in total. Read
              the settlement cycle and trading window as a proxy for how quickly you can act on a view.
            </p>
          </div>

          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[54rem] text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-left">
                  {["Exchange", "City", "Est.", "Currency", "Securities", "Benchmark", "Settlement", "Trading window"].map(
                    (h) => (
                      <th
                        key={h}
                        className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase pb-3 px-3 border-b border-gray-200 whitespace-nowrap"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {exchanges.map((e) => (
                  <tr key={e.id} className="hover:bg-sand transition-colors">
                    <td className="py-3.5 px-3 border-b border-gray-100">
                      <a href={`#${e.id}`} className="flex items-center gap-2.5 group">
                        <span>{e.flag}</span>
                        <span className="font-bold text-ink group-hover:text-gold-dim transition-colors">
                          {e.abbr}
                        </span>
                      </a>
                    </td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-slate-600">{e.city}</td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-slate-600">
                      {e.founded.match(/\d{4}/)?.[0]}
                    </td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-slate-600 font-mono text-xs">
                      {e.currencyCode}
                    </td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-ink font-semibold">
                      {listingCount(e)}
                    </td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-slate-600 font-mono text-xs">
                      {e.indices[0].abbr}
                    </td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-slate-600 whitespace-nowrap">
                      {e.depository.settlement.split(";")[0].split(",")[0]}
                    </td>
                    <td className="py-3.5 px-3 border-b border-gray-100 text-slate-600 whitespace-nowrap text-xs">
                      {e.tradingWindow}{" "}
                      <span className="text-gray-400">{e.timezone}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Exchange profiles */}
      <section className="py-16 bg-sand border-y border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-3xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">
              Market Profiles
            </p>
            <h2 className="text-3xl font-black text-ink tracking-tight">
              How Each Exchange Works
            </h2>
          </div>

          <div className="space-y-8">
            {exchanges.map((e) => (
              <article
                key={e.id}
                id={e.id}
                className="scroll-mt-20 bg-white border border-gray-200 rounded-2xl p-6 sm:p-8"
              >
                {/* Header */}
                <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
                  <div className="flex items-center gap-4">
                    <span className="text-4xl leading-none">{e.flag}</span>
                    <div>
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <h3 className="text-2xl font-black text-ink tracking-tight">{e.name}</h3>
                        <span className="font-mono text-[11px] font-bold text-gold-dim bg-amber-50 border border-gold/30 rounded px-2 py-0.5">
                          {e.abbr}
                        </span>
                      </div>
                      <p className="text-slate-500 text-sm mt-1">
                        {e.city} · {e.founded}
                      </p>
                    </div>
                  </div>
                  <a
                    href={e.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-xs font-semibold text-slate-600 hover:border-gold hover:text-gold-dim transition-colors shrink-0"
                  >
                    Live board
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>

                <p className="text-slate-600 text-sm leading-relaxed max-w-4xl mb-7">{e.overview}</p>

                {/* Facts */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-gray-200 border border-gray-200 rounded-xl overflow-hidden mb-7">
                  <Fact label="Regulator">
                    <a
                      href={e.regulator.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink hover:text-gold-dim transition-colors underline decoration-gray-300 underline-offset-2"
                    >
                      {e.regulator.name}
                    </a>
                  </Fact>
                  <Fact label="Depository">{e.depository.name}</Fact>
                  <Fact label="Settlement">{e.depository.settlement}</Fact>
                  <Fact label={`Sessions (${e.timezone})`}>
                    <span className="space-y-0.5 block">
                      {e.sessions.map((s) => (
                        <span key={s.label} className="block">
                          <span className="text-slate-500">{s.label}</span>{" "}
                          <span className="font-mono text-[13px]">{s.time}</span>
                        </span>
                      ))}
                    </span>
                  </Fact>
                  <Fact label="Listed securities">
                    {listingCount(e)} on the register at {DATA_AS_OF}
                  </Fact>
                  <Fact label="Quoted in">
                    {e.currency} ({e.currencyCode})
                  </Fact>
                </div>

                {/* Indices */}
                <div className="mb-7">
                  <p className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase mb-3">
                    Indices
                  </p>
                  <div className="space-y-2.5">
                    {e.indices.map((idx) => (
                      <div key={idx.abbr} className="flex flex-col sm:flex-row sm:gap-4">
                        <div className="sm:w-40 shrink-0">
                          <span className="font-mono text-[13px] font-bold text-ink">{idx.abbr}</span>
                          <span className="block text-slate-500 text-[11px]">{idx.name}</span>
                        </div>
                        <p className="text-slate-600 text-xs leading-relaxed sm:pt-0.5">{idx.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Segments */}
                <div className="mb-7">
                  <p className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase mb-3">
                    Market segments
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {e.segments.map((s) => (
                      <span
                        key={s}
                        className="px-3 py-1.5 rounded-lg bg-sand border border-gray-200 text-slate-600 text-xs font-medium"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Foreign access */}
                <div className="mb-7 bg-sand border border-gray-200 rounded-xl p-5">
                  <p className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase mb-2">
                    Foreign investor access
                  </p>
                  <p className="text-slate-600 text-sm leading-relaxed">{e.foreignAccess}</p>
                </div>

                {/* Other venues */}
                <div>
                  <p className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase mb-3">
                    Other venues &amp; market infrastructure
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {e.otherVenues.map((v) => (
                      <a
                        key={v.label}
                        href={v.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="border border-gray-200 rounded-xl p-4 hover:border-gold/50 hover:shadow-sm transition-all group"
                      >
                        <h4 className="text-ink text-sm font-semibold mb-1 group-hover:text-gold-dim transition-colors leading-snug">
                          {v.label}
                        </h4>
                        <p className="text-slate-600 text-xs leading-relaxed">{v.desc}</p>
                      </a>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Listings directory */}
      <section id="listings" className="py-16 bg-white scroll-mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-3xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">
              The Stocks
            </p>
            <h2 className="text-3xl font-black text-ink tracking-tight mb-3">
              Every Listed Company, by Sector
            </h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              All {totalListings} securities on the five registers, grouped by the sector
              classification each exchange uses itself, with end-of-day prices in local currency and
              US dollars. Search by ticker, company or sector, or filter to a single market.
            </p>
          </div>

          <ExchangeDirectory />
        </div>
      </section>

      {/* Notes */}
      <section className="py-16 bg-sand border-t border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Note title="How to buy">
              Every one of these markets requires a licensed local broker and a depository account
              — a CSD, CDS or SCD account depending on the country. There is no direct-access route
              for an offshore investor; the broker is the market participant, and the account is
              opened in your name before any order can be placed.
            </Note>
            <Note title="Liquidity is the real constraint">
              Outside NGX and the largest Nairobi counters, daily turnover on many of these
              securities is small enough that a position of institutional size cannot be built or
              exited at the quoted price. Treat the screen price as indicative and size accordingly.
            </Note>
            <Note title="Where the prices come from">
              End-of-day prices come from each exchange&apos;s own public board — the GSE API,
              NGX&apos;s market statistics service, the USE delayed-data feed and the MSE price
              table — converted at the day&apos;s USD rate. They are delayed, not real time. Kenya
              carries no prices: the Nairobi Securities Exchange publishes no open feed, only
              licensed terminal feeds, so its listings stay reference-only.
            </Note>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-navy py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-2xl font-black text-white mb-3">Building a Position in These Markets?</h2>
          <p className="text-white/60 mb-6 max-w-xl mx-auto text-sm">
            We hold broker and regulator relationships across all five exchanges, and run
            liquidity and counterparty diligence before you commit capital.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity"
            >
              Talk to Our Team
            </Link>
            <Link
              href="/resources"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-white/25 text-white font-semibold text-sm hover:bg-white/10 transition-colors"
            >
              Country Resources
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <p className="text-2xl font-black text-ink tracking-tight">{value}</p>
      <p className="text-slate-500 text-xs mt-0.5">{label}</p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white p-4">
      <p className="text-slate-500 text-[10px] font-semibold tracking-widest uppercase mb-1.5">
        {label}
      </p>
      <div className="text-ink text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6">
      <h3 className="text-ink font-bold text-sm mb-2">{title}</h3>
      <p className="text-slate-600 text-xs leading-relaxed">{children}</p>
    </div>
  );
}
