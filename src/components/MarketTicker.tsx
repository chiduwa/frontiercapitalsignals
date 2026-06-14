"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

// ── Metadata ──────────────────────────────────────────────────────────────────

const CURRENCIES = [
  { code: "GHS", name: "Ghanaian Cedi",     flag: "🇬🇭", symbol: "₵"   },
  { code: "NGN", name: "Nigerian Naira",     flag: "🇳🇬", symbol: "₦"   },
  { code: "KES", name: "Kenyan Shilling",    flag: "🇰🇪", symbol: "KSh" },
  { code: "MWK", name: "Malawian Kwacha",   flag: "🇲🇼", symbol: "MK"  },
  { code: "UGX", name: "Ugandan Shilling",  flag: "🇺🇬", symbol: "USh" },
  { code: "USD", name: "US Dollar",         flag: "🇺🇸", symbol: "$"   },
  { code: "EUR", name: "Euro",              flag: "🇪🇺", symbol: "€"   },
  { code: "GBP", name: "British Pound",     flag: "🇬🇧", symbol: "£"   },
  { code: "JPY", name: "Japanese Yen",      flag: "🇯🇵", symbol: "¥"   },
  { code: "CNY", name: "Chinese Yuan",      flag: "🇨🇳", symbol: "¥"   },
  { code: "CHF", name: "Swiss Franc",       flag: "🇨🇭", symbol: "Fr"  },
  { code: "CAD", name: "Canadian Dollar",   flag: "🇨🇦", symbol: "$"   },
  { code: "AUD", name: "Australian Dollar", flag: "🇦🇺", symbol: "$"   },
];

type CommGroup = "precious_metals" | "base_metals" | "energy" | "agricultural";

const COMMODITIES: { key: string; label: string; group: CommGroup; unit: string; flags?: string[] }[] = [
  { key: "gold",        label: "Gold",        group: "precious_metals", unit: "/oz",    flags: ["🇬🇭","🇺🇬"] },
  { key: "silver",      label: "Silver",      group: "precious_metals", unit: "/oz"    },
  { key: "platinum",    label: "Platinum",    group: "precious_metals", unit: "/oz"    },
  { key: "palladium",   label: "Palladium",   group: "precious_metals", unit: "/oz"    },
  { key: "brent_crude", label: "Brent Crude", group: "energy",          unit: "/bbl",  flags: ["🇳🇬","🇺🇬"] },
  { key: "wti_crude",   label: "WTI Crude",   group: "energy",          unit: "/bbl"   },
  { key: "natural_gas", label: "Nat. Gas",    group: "energy",          unit: "/MMBtu" },
  { key: "copper",      label: "Copper",      group: "base_metals",     unit: "/lb",   flags: ["🇲🇼"] },
  { key: "cocoa",       label: "Cocoa",       group: "agricultural",    unit: "/MT",   flags: ["🇬🇭","🇳🇬"] },
  { key: "coffee",      label: "Coffee",      group: "agricultural",    unit: "/lb",   flags: ["🇰🇪","🇺🇬"] },
  { key: "cotton",      label: "Cotton",      group: "agricultural",    unit: "/lb",   flags: ["🇲🇼","🇺🇬"] },
  { key: "sugar",       label: "Sugar",       group: "agricultural",    unit: "/lb",   flags: ["🇲🇼"] },
];

// Items shown IN the scrolling ticker strip
const TICKER_CURRENCIES  = ["GHS","NGN","KES","MWK","UGX","EUR","GBP","CNY"];
const TICKER_COMMODITIES = ["gold","brent_crude","cocoa","coffee","copper","natural_gas","silver"];

// ── Types ─────────────────────────────────────────────────────────────────────

type RatesPayload = { rates: Record<string, number>; base: string; updated: string };
type CommPayload  = {
  precious_metals: Record<string, number | null>;
  base_metals:     Record<string, number | null>;
  energy:          Record<string, number | null>;
  agricultural:    Record<string, number | null>;
  updated:         string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRate(n: number) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 10)   return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function fmtPrice(n: number) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}

function fmtConverted(n: number) {
  if (n >= 1_000_000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1_000)     return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)         return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function xrate(rates: Record<string, number>, amount: number, from: string, to: string) {
  const f = rates[from] ?? 1;
  const t = rates[to]   ?? 1;
  return (amount / f) * t;
}

function commPrice(comm: CommPayload, key: string, group: CommGroup): number | null {
  return comm[group]?.[key] ?? null;
}

// ── Component ─────────────────────────────────────────────────────────────────

type Panel = "currencies" | "commodities" | "convert";

export default function MarketTicker() {
  const [rates,     setRates]     = useState<RatesPayload | null>(null);
  const [comm,      setComm]      = useState<CommPayload  | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [expanded,  setExpanded]  = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [panel,     setPanel]     = useState<Panel>("currencies");
  const [fromCcy,   setFromCcy]   = useState("USD");
  const [toCcy,     setToCcy]     = useState("GHS");
  const [amount,    setAmount]    = useState("1000");
  const [tick,      setTick]      = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [rr, cr] = await Promise.all([fetch("/api/rates"), fetch("/api/commodities")]);
      const rd: RatesPayload  = await rr.json();
      const cd: CommPayload   = await cr.json();
      if (!("error" in rd)) setRates(rd);
      if (!("error" in cd)) setComm(cd);
      setTick(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── Ticker items ────────────────────────────────────────────────────────────

  type TickerItem = { id: string; label: string; flag?: string; value: string; sub: string; isCurrency: boolean };

  const tickerItems: TickerItem[] = [
    ...TICKER_CURRENCIES.map(code => {
      const meta = CURRENCIES.find(c => c.code === code)!;
      const rate = rates?.rates[code];
      return {
        id: code,
        label: code,
        flag: meta.flag,
        value: rate != null ? fmtRate(rate) : "—",
        sub: "/ USD",
        isCurrency: true,
      };
    }),
    ...TICKER_COMMODITIES.map(key => {
      const meta = COMMODITIES.find(c => c.key === key)!;
      const price = comm ? commPrice(comm, key, meta.group) : null;
      return {
        id: key,
        label: meta.label,
        flag: meta.flags?.[0],
        value: price != null ? `$${fmtPrice(price)}` : "—",
        sub: `USD${meta.unit}`,
        isCurrency: false,
      };
    }),
  ];

  // ── Converter ───────────────────────────────────────────────────────────────

  const numAmount   = parseFloat(amount) || 0;
  const converted   = rates?.rates ? xrate(rates.rates, numAmount, fromCcy, toCcy) : 0;
  const toMeta      = CURRENCIES.find(c => c.code === toCcy);
  const fromMeta    = CURRENCIES.find(c => c.code === fromCcy);

  if (dismissed) return null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">

      {/* ── Expanded panel ─────────────────────────────────────────────────── */}
      {expanded && (
        <div className="bg-white border-t border-l border-r border-gray-200 shadow-2xl shadow-black/20 mx-0 sm:mx-4 sm:rounded-t-2xl overflow-hidden">

          {/* Panel tabs + close */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-sand border-b border-gray-200">
            <div className="flex gap-1">
              {(["currencies", "commodities", "convert"] as Panel[]).map(p => (
                <button
                  key={p}
                  onClick={() => setPanel(p)}
                  className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                    panel === p ? "bg-navy text-white" : "text-slate-500 hover:text-ink"
                  }`}
                >
                  {p === "currencies" ? "Currencies" : p === "commodities" ? "Commodities" : "Converter"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {tick && <span className="text-xs text-slate-400 hidden sm:block">Updated {tick}</span>}
              <button
                onClick={fetchAll}
                className="text-xs text-gold hover:underline hidden sm:block"
              >
                Refresh
              </button>
              <Link href="/markets" className="text-xs font-semibold text-gold hover:underline">
                Full view →
              </Link>
              <button
                onClick={() => setExpanded(false)}
                className="p-1 rounded text-slate-400 hover:text-ink hover:bg-gray-100 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Panel body */}
          <div className="max-h-64 overflow-y-auto">

            {/* ── Currencies tab ── */}
            {panel === "currencies" && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-gray-100">
                {CURRENCIES.filter(c => c.code !== "USD").map(c => {
                  const rate = rates?.rates[c.code];
                  return (
                    <div key={c.code} className="bg-white px-4 py-3 hover:bg-sand/60 transition-colors">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-lg leading-none">{c.flag}</span>
                        <span className="text-[11px] font-bold text-slate-500 tracking-wide">{c.code}</span>
                      </div>
                      <p className="font-mono font-bold text-ink text-sm tabular-nums leading-none">
                        {rate != null ? fmtRate(rate) : <span className="text-slate-200">—</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-1">per USD</p>
                    </div>
                  );
                })}
                {/* USD base card */}
                <div className="bg-navy/5 px-4 py-3 border border-navy/10">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-lg leading-none">🇺🇸</span>
                    <span className="text-[11px] font-bold text-slate-500 tracking-wide">USD</span>
                  </div>
                  <p className="font-mono font-bold text-ink text-sm tabular-nums leading-none">1.0000</p>
                  <p className="text-[10px] text-slate-400 mt-1">base currency</p>
                </div>
              </div>
            )}

            {/* ── Commodities tab ── */}
            {panel === "commodities" && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-gray-100">
                {COMMODITIES.map(c => {
                  const price = comm ? commPrice(comm, c.key, c.group) : null;
                  return (
                    <div key={c.key} className="bg-white px-4 py-3 hover:bg-sand/60 transition-colors">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-bold text-slate-500 tracking-wide uppercase">{c.label}</span>
                        {c.flags && <span className="text-xs leading-none">{c.flags.join("")}</span>}
                      </div>
                      <p className="font-mono font-bold text-ink text-sm tabular-nums leading-none">
                        {price != null ? `$${fmtPrice(price)}` : <span className="text-slate-200">—</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-1">USD{c.unit}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Converter tab ── */}
            {panel === "convert" && (
              <div className="p-5 max-w-lg mx-auto">
                <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
                  {/* Amount + From */}
                  <div className="flex gap-2 flex-1">
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
                      className="px-2 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none min-w-[90px]"
                    >
                      {CURRENCIES.map(c => (
                        <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                      ))}
                    </select>
                  </div>

                  {/* Swap */}
                  <button
                    onClick={() => { setFromCcy(toCcy); setToCcy(fromCcy); }}
                    className="self-center w-9 h-9 rounded-full border border-gray-200 bg-white flex items-center justify-center hover:border-gold hover:text-gold transition-colors text-slate-400 shrink-0 mx-auto sm:mx-0"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </button>

                  {/* To */}
                  <div className="flex gap-2 flex-1">
                    <select
                      value={toCcy}
                      onChange={e => setToCcy(e.target.value)}
                      className="flex-1 px-2 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none"
                    >
                      {CURRENCIES.map(c => (
                        <option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Result */}
                <div className="mt-4 bg-sand border border-gray-200 rounded-xl p-4">
                  {rates?.rates ? (
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div>
                        <p className="text-xs text-slate-400 mb-0.5">
                          {fromMeta?.flag} {numAmount.toLocaleString()} {fromCcy} =
                        </p>
                        <p className="text-2xl font-black text-ink tabular-nums">
                          <span className="text-gold">{toMeta?.symbol} </span>
                          {fmtConverted(converted)}
                          <span className="text-sm font-medium text-slate-400 ml-1">{toCcy}</span>
                        </p>
                      </div>
                      <div className="text-xs text-slate-400 sm:text-right shrink-0">
                        <p>1 {fromCcy} = {toMeta?.symbol}{fmtConverted(xrate(rates.rates, 1, fromCcy, toCcy))} {toCcy}</p>
                        <p className="mt-0.5">1 {toCcy} = {fromMeta?.symbol}{fmtConverted(xrate(rates.rates, 1, toCcy, fromCcy))} {fromCcy}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">Loading live rates...</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Panel footer */}
          <div className="px-4 py-2 border-t border-gray-100 bg-sand/50 flex items-center justify-between">
            <p className="text-[10px] text-slate-400">
              FX rates from open.er-api.com · Commodities 15–20 min delayed · Not financial advice
            </p>
            <button onClick={fetchAll} className="text-[10px] text-gold hover:underline sm:hidden">
              Refresh
            </button>
          </div>
        </div>
      )}

      {/* ── Ticker bar ─────────────────────────────────────────────────────── */}
      <div className="bg-navy border-t border-white/10 flex items-center h-11 select-none">

        {/* Brand */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="shrink-0 h-full flex items-center gap-2 px-3 border-r border-white/10 hover:bg-white/5 transition-colors"
        >
          <div className="w-5 h-5 rounded bg-gold/20 flex items-center justify-center shrink-0">
            <svg className="w-3 h-3 text-gold" viewBox="0 0 12 12" fill="currentColor">
              <rect x="0" y="7" width="2" height="4" rx="0.5"/>
              <rect x="3" y="5" width="2" height="6" rx="0.5"/>
              <rect x="6" y="3" width="2" height="8" rx="0.5"/>
              <rect x="9" y="1" width="2" height="10" rx="0.5" opacity="0.7"/>
            </svg>
          </div>
          <span className="text-white/50 text-[9px] font-black tracking-widest uppercase hidden sm:block">
            FCS Markets
          </span>
        </button>

        {/* Scrolling ticker */}
        <div className="flex-1 overflow-hidden h-full flex items-center">
          {loading ? (
            <div className="flex gap-8 px-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-2.5 bg-white/10 rounded w-16 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="ticker-track">
              {[...tickerItems, ...tickerItems].map((item, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setPanel(item.isCurrency ? "currencies" : "commodities");
                    setExpanded(true);
                  }}
                  className="inline-flex items-center gap-2 px-4 h-11 border-r border-white/5 hover:bg-white/8 transition-colors shrink-0 group"
                >
                  {item.flag && (
                    <span className="text-sm leading-none">{item.flag}</span>
                  )}
                  <span className="text-white/50 text-[10px] font-semibold tracking-wide group-hover:text-white/70 transition-colors">
                    {item.label}
                  </span>
                  <span className="text-white font-mono text-xs font-bold tabular-nums">
                    {item.value}
                  </span>
                  <span className="text-white/25 text-[9px]">{item.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="shrink-0 flex items-center h-full border-l border-white/10">
          <button
            onClick={() => setPanel("convert")}
            className="h-full px-3 text-gold/70 hover:text-gold hover:bg-white/5 transition-colors hidden sm:flex items-center"
            title="Open converter"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
          <button
            onClick={() => { setExpanded(e => !e); }}
            className="h-full px-3 text-white/40 hover:text-white hover:bg-white/5 transition-colors flex items-center border-l border-white/10"
            title={expanded ? "Collapse" : "Expand"}
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={() => { setExpanded(false); setDismissed(true); }}
            className="h-full px-3 text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors flex items-center border-l border-white/10"
            title="Hide"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
