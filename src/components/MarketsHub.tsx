"use client";

import { useState, useEffect, useCallback } from "react";

const AFRICAN = [
  { code: "GHS", name: "Ghanaian Cedi",     flag: "🇬🇭", symbol: "₵"   },
  { code: "NGN", name: "Nigerian Naira",     flag: "🇳🇬", symbol: "₦"   },
  { code: "KES", name: "Kenyan Shilling",    flag: "🇰🇪", symbol: "KSh" },
  { code: "MWK", name: "Malawian Kwacha",   flag: "🇲🇼", symbol: "MK"  },
  { code: "UGX", name: "Ugandan Shilling",  flag: "🇺🇬", symbol: "USh" },
];

const GLOBAL = [
  { code: "USD", name: "US Dollar",        flag: "🇺🇸", symbol: "$"  },
  { code: "EUR", name: "Euro",              flag: "🇪🇺", symbol: "€"  },
  { code: "GBP", name: "British Pound",     flag: "🇬🇧", symbol: "£"  },
  { code: "JPY", name: "Japanese Yen",      flag: "🇯🇵", symbol: "¥"  },
  { code: "CNY", name: "Chinese Yuan",      flag: "🇨🇳", symbol: "¥"  },
  { code: "CHF", name: "Swiss Franc",       flag: "🇨🇭", symbol: "Fr" },
  { code: "CAD", name: "Canadian Dollar",   flag: "🇨🇦", symbol: "$"  },
  { code: "AUD", name: "Australian Dollar", flag: "🇦🇺", symbol: "$"  },
];

const ALL_CURRENCIES = [...GLOBAL, ...AFRICAN];

type CommodityGroup = {
  label: string;
  key: string;
  unit: string;
  countries?: string[];
};

const COMMODITY_GROUPS: { id: string; label: string; items: CommodityGroup[] }[] = [
  {
    id: "precious_metals",
    label: "Precious Metals",
    items: [
      { key: "gold",      label: "Gold",      unit: "USD / troy oz", countries: ["🇬🇭","🇺🇬"] },
      { key: "silver",    label: "Silver",    unit: "USD / troy oz" },
      { key: "platinum",  label: "Platinum",  unit: "USD / troy oz" },
      { key: "palladium", label: "Palladium", unit: "USD / troy oz" },
    ],
  },
  {
    id: "base_metals",
    label: "Energy",
    items: [
      { key: "brent_crude",  label: "Brent Crude",  unit: "USD / bbl", countries: ["🇳🇬","🇺🇬"] },
      { key: "wti_crude",    label: "WTI Crude",    unit: "USD / bbl", countries: ["🇳🇬","🇺🇬"] },
      { key: "natural_gas",  label: "Natural Gas",  unit: "USD / MMBtu" },
      { key: "copper",       label: "Copper",       unit: "USD / lb",  countries: ["🇲🇼"] },
    ],
  },
  {
    id: "agricultural",
    label: "Agricultural",
    items: [
      { key: "cocoa",   label: "Cocoa",   unit: "USD / MT",  countries: ["🇬🇭","🇳🇬"] },
      { key: "coffee",  label: "Coffee",  unit: "USD / lb",  countries: ["🇰🇪","🇺🇬"] },
      { key: "cotton",  label: "Cotton",  unit: "USD / lb",  countries: ["🇲🇼","🇺🇬"] },
      { key: "sugar",   label: "Sugar",   unit: "USD / lb",  countries: ["🇲🇼"] },
    ],
  },
];

function fmtRate(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function fmtResult(n: number): string {
  if (n >= 1_000_000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1_000)     return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)         return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function fmtPrice(n: number): string {
  if (n >= 10000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 100)   return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

type RatesData  = { rates: Record<string, number>; base: string; updated: string } | null;
type CommData   = Record<string, Record<string, number | null>> | null;

function getPrice(comm: CommData, groupId: string, key: string): number | null {
  if (!comm) return null;
  // energy items (brent, wti, natgas) are under "energy"; copper is under "base_metals"
  const group =
    comm["precious_metals"]?.[key] !== undefined ? comm["precious_metals"] :
    comm["energy"]?.[key] !== undefined           ? comm["energy"]          :
    comm["base_metals"]?.[key] !== undefined      ? comm["base_metals"]     :
    comm["agricultural"]?.[key] !== undefined     ? comm["agricultural"]    :
    null;
  return group?.[key] ?? null;
}

export default function MarketsHub() {
  const [rates, setRates]       = useState<RatesData>(null);
  const [comm, setComm]         = useState<CommData>(null);
  const [loading, setLoading]   = useState(true);
  const [rateTab, setRateTab]   = useState<"african" | "global">("african");
  const [commTab, setCommTab]   = useState(0);
  const [base, setBase]         = useState("USD");
  const [fromCcy, setFromCcy]   = useState("USD");
  const [toCcy, setToCcy]       = useState("GHS");
  const [amount, setAmount]     = useState("1000");
  const [lastUpdated, setLast]  = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([fetch("/api/rates"), fetch("/api/commodities")]);
      const rd = await r.json();
      const cd = await c.json();
      setRates(rd.error ? null : rd);
      setComm(cd.error ? null : cd);
      setLast(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Cross-rate: amount in "from" → "to", all rates are vs USD
  function convert(val: number, from: string, to: string): number {
    if (!rates?.rates) return 0;
    const r = rates.rates;
    const fromRate = r[from] ?? 1;
    const toRate   = r[to]   ?? 1;
    return (val / fromRate) * toRate;
  }

  const numAmount   = parseFloat(amount) || 0;
  const converted   = convert(numAmount, fromCcy, toCcy);
  const fromInfo    = ALL_CURRENCIES.find(c => c.code === fromCcy);
  const toInfo      = ALL_CURRENCIES.find(c => c.code === toCcy);

  // Rate table: show 1 unit of "base" in each row currency
  function rateVsBase(code: string): number | null {
    if (!rates?.rates) return null;
    return convert(1, base, code);
  }

  const displayRows = rateTab === "african" ? AFRICAN : GLOBAL;
  const activeGroup = COMMODITY_GROUPS[commTab];

  return (
    <div className="bg-white">

      {/* ── Rates + Converter ── */}
      <section className="py-14 border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">

            {/* Exchange rate table */}
            <div className="lg:col-span-3">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <div className="flex gap-1">
                  {(["african", "global"] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setRateTab(t)}
                      className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors capitalize ${
                        rateTab === t ? "bg-navy text-white" : "bg-gray-100 text-slate-500 hover:text-ink"
                      }`}
                    >
                      {t === "african" ? "African Currencies" : "Global Currencies"}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Base:</span>
                  <select
                    value={base}
                    onChange={e => setBase(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1 text-ink bg-white focus:outline-none"
                  >
                    {["USD","EUR","GBP","GHS","NGN","KES"].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-sand border-b border-gray-200">
                      <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wide">Currency</th>
                      <th className="text-right py-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wide">1 {base} =</th>
                      <th className="text-right py-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wide hidden sm:table-cell">Code</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {loading
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <tr key={i}>
                            <td className="py-3 px-4"><div className="h-4 bg-gray-100 rounded w-36 animate-pulse" /></td>
                            <td className="py-3 px-4"><div className="h-4 bg-gray-100 rounded w-20 ml-auto animate-pulse" /></td>
                            <td className="py-3 px-4 hidden sm:table-cell"><div className="h-4 bg-gray-100 rounded w-12 ml-auto animate-pulse" /></td>
                          </tr>
                        ))
                      : displayRows.map(({ code, name, flag }) => {
                          const rate = rateVsBase(code);
                          return (
                            <tr key={code} className="hover:bg-sand/50 transition-colors">
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5">
                                  <span className="text-xl leading-none">{flag}</span>
                                  <span className="text-ink font-medium">{name}</span>
                                </div>
                              </td>
                              <td className="py-3 px-4 text-right font-mono font-semibold text-ink tabular-nums">
                                {rate != null ? fmtRate(rate) : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="py-3 px-4 text-right hidden sm:table-cell">
                                <span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-slate-500 text-xs font-semibold">{code}</span>
                              </td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
              </div>
              {lastUpdated && (
                <p className="text-xs text-slate-400 mt-2">
                  Rates updated {lastUpdated} &mdash;{" "}
                  <button onClick={fetchAll} className="text-gold hover:underline">Refresh</button>
                </p>
              )}
            </div>

            {/* Currency converter */}
            <div className="lg:col-span-2">
              <h2 className="text-lg font-bold text-ink mb-4">Currency Converter</h2>
              <div className="bg-sand border border-gray-200 rounded-xl p-5 space-y-4">

                {/* Amount + From */}
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">From</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      className="flex-1 min-w-0 px-3 py-2.5 border border-gray-200 rounded-lg text-ink font-mono text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/30"
                      placeholder="Amount"
                    />
                    <select
                      value={fromCcy}
                      onChange={e => setFromCcy(e.target.value)}
                      className="px-3 py-2.5 border border-gray-200 rounded-lg text-ink text-sm bg-white focus:outline-none min-w-[90px]"
                    >
                      {ALL_CURRENCIES.map(c => (
                        <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Swap button */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-gray-200" />
                  <button
                    onClick={() => { setFromCcy(toCcy); setToCcy(fromCcy); }}
                    className="w-9 h-9 rounded-full border border-gray-200 bg-white flex items-center justify-center hover:border-gold hover:text-gold transition-colors text-slate-400 shrink-0"
                    title="Swap currencies"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </button>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>

                {/* To */}
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">To</label>
                  <select
                    value={toCcy}
                    onChange={e => setToCcy(e.target.value)}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-ink text-sm bg-white focus:outline-none"
                  >
                    {ALL_CURRENCIES.map(c => (
                      <option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>
                    ))}
                  </select>
                </div>

                {/* Result */}
                <div className="bg-white border border-gold/30 rounded-xl p-4">
                  {loading ? (
                    <div className="h-8 bg-gray-100 rounded animate-pulse w-3/4" />
                  ) : rates?.rates ? (
                    <>
                      <p className="text-xs text-slate-400 mb-1">
                        {numAmount.toLocaleString()} {fromInfo?.flag} {fromCcy} =
                      </p>
                      <p className="text-2xl font-black text-ink tabular-nums">
                        <span className="text-gold">{toInfo?.symbol} </span>
                        {fmtResult(converted)}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">{toInfo?.flag} {toCcy}</p>
                      <hr className="my-3 border-gray-100" />
                      <p className="text-xs text-slate-400">
                        1 {fromCcy} = {toInfo?.symbol}{fmtResult(convert(1, fromCcy, toCcy))} {toCcy}
                        <span className="ml-2 text-slate-300">|</span>
                        <span className="ml-2">1 {toCcy} = {fromInfo?.symbol}{fmtResult(convert(1, toCcy, fromCcy))} {fromCcy}</span>
                      </p>
                    </>
                  ) : (
                    <p className="text-slate-400 text-sm">Unable to load rates</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Commodities ── */}
      <section className="py-14 bg-sand">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-end justify-between flex-wrap gap-4 mb-8">
            <div>
              <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-2">Live Prices</p>
              <h2 className="text-3xl font-black text-ink tracking-tight">Commodities</h2>
              <p className="text-slate-500 text-sm mt-1">Key exports across our five focus markets</p>
            </div>
            <div className="flex gap-1">
              {COMMODITY_GROUPS.map((g, i) => (
                <button
                  key={g.id}
                  onClick={() => setCommTab(i)}
                  className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                    commTab === i ? "bg-navy text-white" : "bg-white border border-gray-200 text-slate-500 hover:text-ink"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {activeGroup.items.map(({ key, label, unit, countries }) => {
              const price = getPrice(comm, activeGroup.id, key);
              return (
                <div key={key} className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{unit}</p>
                    </div>
                    {countries && (
                      <div className="flex gap-0.5 text-base leading-none">
                        {countries.map(f => <span key={f}>{f}</span>)}
                      </div>
                    )}
                  </div>
                  {loading ? (
                    <div className="h-8 bg-gray-100 rounded animate-pulse w-2/3" />
                  ) : price != null ? (
                    <p className="text-2xl font-black text-ink tabular-nums">
                      <span className="text-base font-semibold text-slate-400">$</span>
                      {fmtPrice(price)}
                    </p>
                  ) : (
                    <p className="text-2xl font-black text-slate-200">—</p>
                  )}
                </div>
              );
            })}
          </div>

          {lastUpdated && (
            <p className="text-xs text-slate-400 mt-5">
              Commodity prices delayed 15–20 min &mdash; last fetched {lastUpdated}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
