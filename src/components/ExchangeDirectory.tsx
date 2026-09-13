"use client";

import { useEffect, useMemo, useState } from "react";
import { exchanges, DATA_AS_OF } from "@/lib/exchanges";

const ALL = "all";

/** Symbols the five markets quote in, for the local-currency column. */
const CURRENCY_SYMBOL: Record<string, string> = {
  GHS: "₵",
  NGN: "₦",
  KES: "KSh",
  MWK: "MK",
  UGX: "USh",
};

const STATUS_LABEL: Record<string, string> = {
  suspended: "Suspended",
  watchlist: "Delisting watchlist",
  restructuring: "Restructuring",
};

type Quote = {
  price: number;
  change: number | null;
  changePct: number | null;
  marketCap: number | null;
  volume: number | null;
};

type QuotesPayload = {
  asOf: string;
  fx: Record<string, number>;
  sources: Record<string, "ok" | "unavailable">;
  quotes: Record<string, Record<string, Quote>>;
};

function formatLocal(value: number, code: string) {
  const symbol = CURRENCY_SYMBOL[code] ?? "";
  // Sub-unit prices are common on these boards (Ghanaian pesewa-level counters),
  // so keep two decimals throughout rather than rounding them to zero.
  const n = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${symbol}${n}`;
}

function formatUsd(value: number) {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCap(usd: number) {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}bn`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}m`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

export default function ExchangeDirectory() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>(ALL);
  const [data, setData] = useState<QuotesPayload | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/quotes")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: QuotesPayload) => {
        if (cancelled) return;
        setData(d);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = query.trim().toLowerCase();

  // Group the surviving rows back into exchange → sector so the table keeps its
  // structure while filtering, rather than collapsing into a flat result list.
  const groups = useMemo(() => {
    return exchanges
      .filter((e) => active === ALL || e.id === active)
      .map((e) => ({
        exchange: e,
        sectors: e.sectors
          .map((s) => ({
            name: s.name,
            listings: s.listings.filter(
              (l) =>
                !q ||
                l.ticker.toLowerCase().includes(q) ||
                l.name.toLowerCase().includes(q) ||
                s.name.toLowerCase().includes(q)
            ),
          }))
          .filter((s) => s.listings.length > 0),
      }))
      .filter((g) => g.sectors.length > 0);
  }, [q, active]);

  const matchCount = groups.reduce(
    (n, g) => n + g.sectors.reduce((m, s) => m + s.listings.length, 0),
    0
  );

  const pricedAt = data?.asOf
    ? new Date(data.asOf).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    : null;

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <svg
            className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker, company or sector…"
            aria-label="Search listed companies"
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-white border border-gray-200 text-sm text-ink placeholder:text-gray-400 focus:outline-none focus:border-gold focus:ring-1 focus:ring-gold/40"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <FilterChip label="All markets" activeState={active === ALL} onClick={() => setActive(ALL)} />
          {exchanges.map((e) => (
            <FilterChip
              key={e.id}
              label={`${e.flag} ${e.abbr}`}
              activeState={active === e.id}
              onClick={() => setActive(e.id)}
            />
          ))}
        </div>
      </div>

      {/* Data provenance */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-6 text-xs">
        <span className="text-slate-500" aria-live="polite">
          {matchCount} {matchCount === 1 ? "security" : "securities"}
          {q && <> matching &ldquo;{query.trim()}&rdquo;</>} · register as at {DATA_AS_OF}
        </span>
        {loadState === "loading" && <span className="text-slate-400">Loading prices…</span>}
        {loadState === "ready" && pricedAt && (
          <span className="text-slate-500">
            Prices {pricedAt} · end of day, converted at the day&apos;s USD rate
          </span>
        )}
        {loadState === "failed" && (
          <span className="text-amber-700">Price feed unavailable — showing reference data only</span>
        )}
      </div>

      {groups.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center">
          <p className="text-ink font-bold text-sm mb-1">No securities match that search</p>
          <p className="text-slate-500 text-xs">Try a ticker such as MTNN, a company name, or a sector like &ldquo;Banking&rdquo;.</p>
        </div>
      )}

      <div className="space-y-12">
        {groups.map(({ exchange: e, sectors }) => {
          const feed = data?.quotes?.[e.id];
          const rate = data?.fx?.[e.currencyCode];
          const priced = data?.sources?.[e.id] === "ok" && !!rate;

          return (
            <div key={e.id}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4 pb-3 border-b border-gray-200">
                <span className="text-xl leading-none">{e.flag}</span>
                <h3 className="text-ink font-black text-lg tracking-tight">{e.abbr}</h3>
                <span className="text-slate-500 text-sm">{e.name}</span>
                <span className="ml-auto text-slate-500 text-xs shrink-0">
                  {priced ? (
                    <>
                      Quoted in {e.currencyCode} · $1 = {rate!.toLocaleString("en-US", { maximumFractionDigits: 2 })}{" "}
                      {e.currencyCode}
                    </>
                  ) : (
                    <>
                      Quoted in {e.currencyCode} ·{" "}
                      {/* An exchange absent from `sources` has no feed at all (Kenya);
                          one present but not "ok" is a transient upstream failure. */}
                      {data && !(e.id in (data.sources ?? {}))
                        ? "no public price feed"
                        : "price feed unavailable"}
                    </>
                  )}
                </span>
              </div>

              <div className="space-y-6">
                {sectors.map((s) => (
                  <div key={s.name}>
                    <p className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase mb-2.5">
                      {s.name} <span className="text-gray-400">({s.listings.length})</span>
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {s.listings.map((l) => {
                        const quote = feed?.[l.ticker];
                        return (
                          <div
                            key={`${e.id}-${l.ticker}`}
                            className="bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-gold/50 transition-colors"
                          >
                            <div className="flex items-baseline gap-2 mb-0.5">
                              <span className="font-mono text-[13px] font-bold text-ink">{l.ticker}</span>
                              {l.status && (
                                <span
                                  className={`text-[9px] font-bold tracking-wider uppercase rounded px-1.5 py-0.5 border ${
                                    l.status === "suspended"
                                      ? "text-red-700 bg-red-50 border-red-200"
                                      : "text-amber-700 bg-amber-50 border-amber-200"
                                  }`}
                                >
                                  {STATUS_LABEL[l.status]}
                                </span>
                              )}
                              {quote?.changePct != null && quote.changePct !== 0 && (
                                <span
                                  className={`ml-auto text-[11px] font-semibold tabular-nums ${
                                    quote.changePct > 0 ? "text-emerald-700" : "text-red-700"
                                  }`}
                                >
                                  {quote.changePct > 0 ? "+" : ""}
                                  {quote.changePct.toFixed(2)}%
                                </span>
                              )}
                            </div>
                            <p className="text-slate-600 text-xs leading-snug">{l.name}</p>

                            {quote && rate && (
                              <div className="mt-2 pt-2 border-t border-gray-100 flex items-baseline gap-2 flex-wrap">
                                <span className="text-ink text-sm font-bold tabular-nums">
                                  {formatLocal(quote.price, e.currencyCode)}
                                </span>
                                <span className="text-slate-500 text-xs tabular-nums">
                                  {formatUsd(quote.price / rate)}
                                </span>
                                {quote.marketCap != null && (
                                  <span className="text-slate-500 text-[11px] ml-auto tabular-nums">
                                    {formatCap(quote.marketCap / rate)} cap
                                  </span>
                                )}
                              </div>
                            )}

                            {l.note && (
                              <p className="text-slate-500 text-[11px] leading-relaxed mt-1.5 pt-1.5 border-t border-gray-100">
                                {l.note}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  activeState,
  onClick,
}: {
  label: string;
  activeState: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activeState}
      className={`px-3.5 py-2 rounded-lg border text-xs font-semibold transition-colors ${
        activeState
          ? "bg-navy border-navy text-white"
          : "bg-white border-gray-200 text-slate-600 hover:border-navy hover:text-navy"
      }`}
    >
      {label}
    </button>
  );
}
