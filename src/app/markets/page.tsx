import type { Metadata } from "next";
import MarketsHub from "@/components/MarketsHub";

export const metadata: Metadata = {
  title: "Live Market Rates",
  description:
    "Live exchange rates for African and global currencies, plus commodity prices for gold, oil, cocoa, coffee and more. Currency converter for GHS, NGN, KES, MWK, UGX and major world currencies.",
  alternates: { canonical: "https://frontiercapitalsignals.com/markets" },
  keywords: [
    "Ghana cedi exchange rate",
    "Nigerian naira rate today",
    "Kenyan shilling USD",
    "Malawi kwacha exchange rate",
    "Uganda shilling rate",
    "African currency converter",
    "gold price today",
    "cocoa price Africa",
    "coffee price Kenya Uganda",
    "Brent crude oil price",
    "Africa commodity prices",
    "GHS NGN KES MWK UGX exchange rate",
  ],
  openGraph: { url: "https://frontiercapitalsignals.com/markets", type: "website" },
};

export default function MarketsPage() {
  return (
    <>
      <section className="bg-sand border-b border-gray-200 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gold/10 border border-gold/30 mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
              <span className="text-gold-dim text-xs font-semibold tracking-widest uppercase">Live Data</span>
            </div>
            <h1 className="text-5xl font-black text-ink mb-4 tracking-tight">Markets</h1>
            <p className="text-slate-500 text-lg leading-relaxed">
              Live exchange rates for African and global currencies, currency conversion, and real-time commodity prices for the key exports of our five focus markets.
            </p>
          </div>
        </div>
      </section>

      <MarketsHub />
    </>
  );
}
