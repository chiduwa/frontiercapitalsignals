import type { Metadata } from "next";
import Link from "next/link";
import JsonLd from "@/components/JsonLd";
import { seoTitle } from "@/lib/seo";
import { getStudy, studyUrl, RESEARCH_BASE } from "@/lib/research";

// Every figure on this page comes from the replay committed at
// signals-worker/docs/research-2026-09-29-grid-bots/ (results/*.txt), and the
// write-up there is the long form. Change a number here only after rerunning
// the script that produced it.

const study = getStudy("binance-grid-bots");
const URL = studyUrl(study.slug);
const OG_IMAGE = `${URL}/opengraph-image`;
const HEADLINE = "Binance Grid Bots Tested: The Best Spot and Futures Settings for 2026";

export const metadata: Metadata = {
  title: { absolute: seoTitle("Best Binance Grid Bot Settings: 72,280 Bots Tested") },
  description:
    "We replayed 72,280 Binance grid bots on 2021–2026 prices. The spot and futures settings that held up, BTC and ETH ranges, and why the Arbitrage Bot beats a grid.",
  keywords: [
    "Binance grid bot settings",
    "best Binance grid bot settings",
    "Binance spot grid",
    "Binance futures grid",
    "are Binance grid bots profitable",
    "Binance grid bot range",
    "how many grids Binance",
    "geometric vs arithmetic grid",
    "Binance Arbitrage Bot",
    "funding rate arbitrage Binance",
    "Binance Rebalancing Bot",
    "Binance Spot DCA bot",
    "grid trading backtest",
    "BTC grid bot settings",
    "ETH grid bot settings",
  ],
  alternates: { canonical: URL },
  // Omitting `images` lets this route's opengraph-image.tsx supply the card.
  openGraph: {
    title: HEADLINE,
    description: study.description,
    type: "article",
    url: URL,
    siteName: "Frontier Capital Signals",
    publishedTime: study.published,
    modifiedTime: study.modified,
    authors: ["Frontier Capital Signals Research"],
    section: "Research",
    tags: study.topics,
  },
  twitter: { card: "summary_large_image", title: HEADLINE, description: study.description },
};

type Row = (string | number)[];

const keyFindings = [
  {
    head: "Grid bots did not beat simply holding.",
    body: "Across 72,280 replayed Binance grids on seven coins (2021–2026), a spot grid trailed holding the coins it started with in all 40 range and grid-count combinations tested, after fees. With the replay’s own bias removed, the market-structure effect is still slightly negative: crypto trends a little more than a random walk, and trends are what grids lose on.",
  },
  {
    head: "A wide BTC spot grid is the least-bad grid.",
    body: "With a range of ±3 standard deviations of volatility and 1.5% per grid, BTC was inside the range 99.7% of the time. The median month made +0.4%, and the worst 10% of months lost 9.0%, against 18.6% for holding BTC outright. It behaves like a calmer half-position in BTC, not an income machine.",
  },
  {
    head: "The Arbitrage Bot is the only bot here with a steady, direction-free return.",
    body: "Long spot BTC plus short BTC perpetual collected funding in every 90-day window of 2021–2025. At September 2026 funding (6.7–7.8% a year gross) it nets roughly 4% a year on capital at 2× leverage. 2026 was weaker: 62% of windows made money.",
  },
  {
    head: "Leverage turns a futures grid into a liquidation bet.",
    body: "A neutral BTC futures grid had a median 30-day result near zero but a worst month of −11% before leverage: −55% at 5×. The worst losses came from rallies, not crashes: on SOL the worst unlevered month was −54%, when SOL rose 331% in 30 days.",
  },
  {
    head: "Don’t grid pump-prone alts.",
    body: "HBAR, XLM and ARB spot grids lost in most months. HBAR’s median 90-day grid lost 3.9%, while holding HBAR over the same runs averaged +14%.",
  },
];

const spotSettings: Row[] = [
  ["Pair", "BTC/USDT", "ETH/USDT"],
  ["Mode", "Geometric", "Geometric"],
  ["Lower price", "58,000", "1,690"],
  ["Upper price", "121,000", "4,380"],
  ["Range", "±44% (3 sd, 30 days)", "±61% (3 sd, 30 days)"],
  ["Grids", "49 (≈1.5% per grid)", "64 (≈1.5% per grid)"],
  ["Tighter option", "65,700–107,300, 33 grids", "1,980–3,735, 43 grids"],
  ["Trailing up", "Off", "Off"],
  ["Stop loss", "Optional, ≈55,000", "Optional, ≈1,600"],
  ["Take profit", "Off", "Off"],
  ["Fees", "Pay in BNB (25% off)", "Pay in BNB (25% off)"],
];

const coinOutcomes: Row[] = [
  ["BTC", "+0.4%", "−9.0%", "−18.6%", "55%"],
  ["ETH", "+0.1%", "−10.4%", "−22.8%", "50%"],
  ["SOL", "+0.5%", "−12.0%", "−28.8%", "52%"],
  ["XRP", "−0.6%", "−8.9%", "−23.0%", "45%"],
  ["XLM", "−0.9%", "−8.7%", "−23.3%", "43%"],
  ["HBAR", "−1.6%", "−10.5%", "−27.0%", "42%"],
  ["ARB", "−0.5%", "−12.8%", "−29.0%", "49%"],
];

const arbSettings: Row[] = [
  ["Bot", "Arbitrage Bot (funding rate), positive carry"],
  ["Pair", "BTCUSDT (ETHUSDT second)"],
  ["Position", "Long spot, short USDⓈ-M perpetual, equal size"],
  ["Leverage", "1–2×"],
  ["Enter when", "7-day average funding ≥ 0.006% per 8 hours (≈6.5% a year)"],
  ["Exit when", "7-day average funding turns negative"],
  ["Expected return", "≈4% a year on capital at 2×, at September 2026 funding"],
  ["Check first", "Binance Simple Earn’s USDT rate: if it pays the same, skip the bot"],
];

const fundingByYear: Row[] = [
  ["BTC", "16.4%", "3.1%", "3.3%", "7.4%", "3.4%", "0.9%"],
  ["ETH", "20.3%", "0.7%", "3.4%", "8.1%", "3.4%", "0.3%"],
  ["SOL", "21.2%", "−4.7%", "−7.7%", "8.9%", "0.4%", "−2.0%"],
  ["XRP", "29.3%", "0.4%", "2.5%", "9.3%", "2.7%", "−1.6%"],
  ["XLM", "32.0%", "0.9%", "0.8%", "7.5%", "−1.1%", "−2.0%"],
  ["HBAR", "13.2%", "2.1%", "−0.2%", "6.7%", "1.8%", "−0.7%"],
];

const fundingNow: Row[] = [
  ["BTC", "7.8%", "7.3%", "6.7%", "1"],
  ["ETH", "6.3%", "4.9%", "4.5%", "7"],
  ["HYPE", "5.1%", "3.9%", "3.5%", "11"],
  ["SOL", "8.0%", "3.5%", "3.4%", "21"],
  ["XRP", "6.0%", "4.4%", "2.6%", "27"],
  ["XLM", "8.2%", "8.1%", "2.6%", "26"],
];

const futuresGrid: Row[] = [
  ["BTC", "+0.04%", "−0.79%", "−5.0%", "−11.1%", "−22%", "−55%"],
  ["ETH", "−0.14%", "−1.18%", "−6.8%", "−12.9%", "−26%", "−64%"],
  ["XRP", "+0.08%", "−2.32%", "−7.5%", "liquidated (−132%)", "liquidated", "liquidated"],
  ["SOL", "−0.34%", "−2.69%", "−13.7%", "−53.5%", "liquidated", "liquidated"],
];

const allBots: Row[] = [
  ["Spot Grid", "Buys dips and sells rallies inside a price range", "Choppy, sideways prices", "Usable on BTC or ETH with a wide range; a calmer way to hold, not extra profit"],
  ["Rebalancing Bot", "Keeps fixed weights across several coins", "Coins taking turns to lead", "Regime-dependent: lost to buy-and-hold in 2021–23, won in 2024–26, tied over the last year"],
  ["Spot DCA", "Buys more as price falls, sells at a take-profit", "Dips that recover", "Same weakness to trends as a grid; for accumulating, plain weekly buys are simpler"],
  ["Spot Algo Orders", "Splits a large order over time", "Nothing: it is an execution tool", "Use only to enter or exit size"],
  ["Futures Grid", "A grid with leverage, long, short or neutral", "Choppy prices", "Median month ≈0, fat losing tail; neutral, BTC, 2× at most, if at all"],
  ["Position Snowball", "New futures bot that builds a directional position", "A correct call on direction", "Not tested; we found no reliable direction signal to feed it"],
  ["Futures DCA", "Averages down with leverage", "Dips that recover before margin runs out", "Avoid: averaging down with leverage ends in liquidation"],
  ["Arbitrage Bot", "Long spot, short perpetual, collects funding", "Positive funding rates", "Best futures choice: ≈4% a year on BTC now, steady in 2021–25"],
  ["Futures TWAP", "Executes an order evenly over time", "Nothing: execution tool", "Use only to enter or exit size"],
  ["Futures VP", "Executes in step with market volume", "Nothing: execution tool", "Use only to enter or exit size"],
];

const faqs = [
  {
    q: "Are Binance grid bots profitable?",
    a: "Not reliably. In 72,280 replayed Binance grids on 2021–2026 prices, spot grids trailed simply holding the coins they started with in every configuration tested, after fees. The Grid Profit figure Binance shows is real, but it is offset by losses on the coins the bot holds when price trends. A wide BTC grid came closest to break-even and halved the drawdown of holding BTC.",
  },
  {
    q: "What are the best Binance spot grid settings?",
    a: "For BTC/USDT at about $83,900 (29 September 2026): geometric mode, lower price 58,000, upper price 121,000, 49 grids (about 1.5% per grid), trailing up off, fees paid in BNB. That is a range of three standard deviations of BTC’s 90-day volatility over 30 days, and BTC was inside such a range 99.7% of the time from 2021 to 2026. Recenter it on the live price before launching.",
  },
  {
    q: "How many grids should I use on a Binance grid bot?",
    a: "Pick the grid count from the spacing, not the other way round: aim for 1–2% per grid on spot and about 1% on futures. Every round trip on spot pays two 0.1% fees, so at 0.5% spacing fees take 40% of each grid’s profit, and at 1.5% about 13%. More grids never improved the result in our replay; the finest spacing did worst.",
  },
  {
    q: "Should I use arithmetic or geometric mode?",
    a: "Geometric. It keeps every grid the same percentage apart, so profit per grid stays the same multiple of the fee across the whole range. Arithmetic grids get thinner in percentage terms toward the top of a wide range.",
  },
  {
    q: "What leverage should I use on a Binance futures grid?",
    a: "Two times at most, in neutral mode, on BTC. A neutral BTC futures grid’s worst 30-day result in 2021–2026 was −11% before leverage, which is −22% at 2× and −55% at 5×. On SOL and XRP the worst months were −54% and −132% before leverage, when each coin more than tripled in 30 days; that liquidates any leverage.",
  },
  {
    q: "Is the Binance Arbitrage Bot worth it?",
    a: "It is the steadiest bot on Binance’s list because it does not depend on price direction. Long spot BTC with a short BTC perpetual made money in every 90-day window from 2021 to 2025. At September 2026 funding it earns about 4% a year on capital at 2×. Only run it while BTC’s 7-day average funding is at least about 6.5% a year, and compare with Binance Simple Earn first.",
  },
  {
    q: "Should I copy top bots from the Binance marketplace?",
    a: "Not on their past PNL. The marketplace sorts by what already happened, so the top of the list is the lucky side of many similar bots. A grid’s past profit says little about the next month, because what decides it is whether price chops or trends, and nothing we tested predicts that.",
  },
  {
    q: "Which coin is best for a grid bot?",
    a: "BTC, then ETH. They had the smallest and most consistent grid shortfall, stayed in range, and have the deepest liquidity. Coins prone to sudden pumps (HBAR, XLM, ARB) did worst: their grids sell out early in a pump and then sit in cash while the coin keeps rising.",
  },
];

const articleSchema = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: HEADLINE,
  description: study.description,
  datePublished: study.published,
  dateModified: study.modified,
  url: URL,
  mainEntityOfPage: { "@type": "WebPage", "@id": URL },
  image: [OG_IMAGE],
  author: {
    "@type": "Organization",
    name: "Frontier Capital Signals Research",
    url: RESEARCH_BASE,
  },
  publisher: {
    "@type": "Organization",
    name: "Frontier Capital Signals",
    url: "https://frontiercapitalsignals.com",
    logo: { "@type": "ImageObject", url: "https://frontiercapitalsignals.com/apple-icon" },
  },
  about: [
    { "@type": "Organization", name: "Binance" },
    { "@type": "Thing", name: "Grid trading" },
    { "@type": "Thing", name: "Cryptocurrency trading bot" },
    { "@type": "Thing", name: "Funding rate arbitrage" },
  ],
  keywords: metadata.keywords,
  articleSection: "Research",
  inLanguage: "en-US",
  isAccessibleForFree: true,
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://frontiercapitalsignals.com" },
    { "@type": "ListItem", position: 2, name: "Research", item: RESEARCH_BASE },
    { "@type": "ListItem", position: 3, name: "Binance grid bots", item: URL },
  ],
};

function Table({ caption, head, rows, firstBold = true }: { caption: string; head: string[]; rows: Row[]; firstBold?: boolean }) {
  return (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 my-6">
      <table className="w-full text-sm border-separate border-spacing-0">
        <caption className="text-left text-slate-500 text-xs mb-3">{caption}</caption>
        <thead>
          <tr className="text-left">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase pb-3 px-3 border-b border-gray-200 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])} className="align-top">
              {r.map((c, i) => (
                <td
                  key={i}
                  className={`py-3 px-3 border-b border-gray-100 ${i === 0 && firstBold ? "font-bold text-ink whitespace-nowrap" : "text-slate-600"}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 text-2xl sm:text-3xl font-black text-ink tracking-tight mt-16 mb-4">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-700 leading-relaxed mb-4">{children}</p>;
}

const toc = [
  ["key-findings", "Key findings"],
  ["are-grid-bots-profitable", "Are Binance grid bots profitable?"],
  ["spot-grid-settings", "Best Binance spot grid settings"],
  ["arbitrage-bot", "Best futures bot: the Arbitrage Bot"],
  ["futures-grid-settings", "Futures grid settings and leverage"],
  ["all-bots", "Every Binance bot compared"],
  ["set-your-own-range", "How to set the range yourself"],
  ["methodology", "How we tested"],
  ["faq", "FAQ"],
];

export default function BinanceGridBotsPage() {
  return (
    <article className="bg-white">
      <JsonLd data={articleSchema} />
      <JsonLd data={faqSchema} />
      <JsonLd data={breadcrumbSchema} />

      <header className="bg-sand border-b border-gray-200 py-14">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb" className="text-xs text-slate-500 mb-5">
            <Link href="/" className="hover:text-gold-dim">Home</Link>
            <span className="mx-2">›</span>
            <Link href="/research" className="hover:text-gold-dim">Research</Link>
            <span className="mx-2">›</span>
            <span className="text-slate-700">Binance grid bots</span>
          </nav>
          <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Trading bot research</p>
          <h1 className="text-3xl sm:text-5xl font-black text-ink tracking-tight leading-tight mb-5">{HEADLINE}</h1>
          <p className="text-slate-600 text-lg leading-relaxed mb-6">
            We replayed 72,280 Binance grid bots on real prices from 2021 to 2026, with Binance’s fees and funding,
            and tested each one against simply holding. Here is which bot to run, the exact range and grid count for
            BTC and ETH, and what leverage does to a futures grid.
          </p>
          <p className="text-slate-500 text-sm">
            By <Link href="/research" className="text-gold-dim underline">Frontier Capital Signals Research</Link> ·
            Published <time dateTime={study.published}>29 September 2026</time> · Price data to 22 September 2026
          </p>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <nav aria-label="Contents" className="border border-gray-200 rounded-2xl p-5 mb-4 bg-white">
          <p className="text-gold-dim text-[11px] font-semibold tracking-widest uppercase mb-3">Contents</p>
          <ol className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm list-decimal list-inside text-slate-600">
            {toc.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:text-gold-dim">{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <section aria-labelledby="key-findings">
          <H2 id="key-findings">Key findings</H2>
          <div className="bg-amber-50 border-l-4 border-gold rounded-r-xl px-6 py-5">
            <ol className="space-y-4 list-decimal list-outside pl-4 text-slate-700 text-[15px] leading-relaxed">
              {keyFindings.map((f) => (
                <li key={f.head}>
                  <strong className="text-ink">{f.head}</strong> {f.body}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="are-grid-bots-profitable">
          <H2 id="are-grid-bots-profitable">Are Binance grid bots profitable?</H2>
          <P>
            <strong>Not reliably, and not more than holding.</strong> A grid bot places buy orders below the price and
            sell orders above it. Every time price drops to a buy and climbs back to the sell above it, the bot books a
            small profit. Binance shows this as <em>Grid Profit</em>, and it really is money made.
          </P>
          <P>
            It is paid for elsewhere. A grid buys more every time price falls and sells some every time price rises, so
            in a trend it always holds the wrong amount: too much of a falling coin, too little of a rising one. That
            loss sits in the bot’s <em>unrealized</em> P&amp;L. If prices move like a random walk, the two cancel on
            average and the fees are left over as a loss. A grid only has an edge if prices bounce back more often than
            chance would, and in our data they did not.
          </P>
          <P>
            We measured this directly. Each grid was compared with holding the exact coins and dollars it started with.
            Across seven coins and 40 settings, every grid trailed that benchmark after fees. Part of the gap comes from
            replaying on daily bars, which miss small intraday swings. To remove that, we ran the same replay on copies
            of every coin with each day’s direction flipped at random, which keeps the volatility but removes any trend
            or bounce-back. Real prices still did worse than the copies, by 0.7–1.0% per 30-day grid before fees, in every
            setting and in both 2021–23 and 2024–26. That gap is small enough to be chance, but it never once went the
            grid’s way: crypto trends slightly more than a random walk, which is exactly what grids lose on. It is the
            same conclusion as our{" "}
            <a href="/signals" className="text-gold-dim underline">signal engine’s</a> tests, where 4,175 models found
            no reliable way to call the next move.
          </P>
          <P>
            So the honest way to think of a spot grid: <strong>a position that is roughly half in the coin, which trims
            rallies and buys dips.</strong> It gives up some upside to cut the downside. That can be worth having. It is
            not free income.
          </P>
        </section>

        <section aria-labelledby="spot-grid-settings">
          <H2 id="spot-grid-settings">Best Binance spot grid settings (BTC and ETH)</H2>
          <P>
            If you run a spot grid, run it on BTC or ETH with a wide geometric range and 1–2% between grids. These are
            the settings at Binance prices of 29 September 2026 (BTC ≈ $83,900, ETH ≈ $2,717). Recenter them on the
            live price when you launch.
          </P>
          <Table caption="Recommended Binance Spot Grid settings, 29 September 2026" head={["Setting", "BTC", "ETH"]} rows={spotSettings} />
          <P>
            Binance sets a minimum size per order, so 49 grids need a few hundred dollars; the bot shows the exact
            minimum when you enter the settings. Leave trailing up off: it re-buys higher as price climbs, which we did
            not test.
          </P>
          <h3 className="text-lg font-bold text-ink mt-8 mb-2">How these settings did, coin by coin</h3>
          <P>
            30-day spot grids with a ±3 standard deviation range and 1.5% per grid, launched every week from 2021 to
            2026, after Binance’s 0.1% fee.
          </P>
          <Table
            caption="Spot grid results per 30-day run, 2021–2026 (daily-bar replay)"
            head={["Coin", "Median grid", "Grid, worst 10%", "Holding coin, worst 10%", "Grid runs that made money"]}
            rows={coinOutcomes}
          />
          <P>
            The grid roughly halved the bad months against holding the coin. It also gave up most of the good ones:
            holding BTC averaged +1.5% a month in these runs, the grid about zero.
          </P>
        </section>

        <section aria-labelledby="arbitrage-bot">
          <H2 id="arbitrage-bot">Best Binance futures bot: the Arbitrage Bot, not a grid</H2>
          <P>
            Binance’s <strong>Arbitrage Bot</strong> buys a coin on spot and shorts the same amount as a perpetual
            future. Price moves cancel out. What is left is the <em>funding rate</em>: when it is positive, which is
            most of the time, shorts are paid by longs every eight hours. It is the only bot on Binance’s list whose
            profit does not depend on guessing where price goes.
          </P>
          <Table caption="Recommended Binance Arbitrage Bot settings, 29 September 2026" head={["Setting", "Value"]} rows={arbSettings} />
          <h3 className="text-lg font-bold text-ink mt-8 mb-2">What it earned, year by year</h3>
          <P>
            Mean net return a year on capital, holding for 90 days at 2× (two thirds of capital working as notional),
            after 0.3% round-trip fees, using Binance’s own funding history.
          </P>
          <Table
            caption="Arbitrage Bot, 90-day holds, net annual return on capital at 2×"
            head={["Coin", "2021", "2022", "2023", "2024", "2025", "2026"]}
            rows={fundingByYear}
          />
          <P>
            BTC made money in every 90-day window from 2021 to 2025. In 2026 funding went negative for part of the first
            half and only 62% of windows made money, which is why the entry rule waits for funding to be clearly
            positive. Altcoins are worse candidates: their funding flips negative far more often.
          </P>
          <Table
            caption="Funding to 22 September 2026, gross annual rate on notional"
            head={["Coin", "Last 7 days", "30 days", "90 days", "Negative days of last 90"]}
            rows={fundingNow}
          />
        </section>

        <section aria-labelledby="futures-grid-settings">
          <H2 id="futures-grid-settings">Binance futures grid settings, and what leverage does</H2>
          <P>
            If you still want a Futures Grid: <strong>neutral mode, BTCUSDT, 2× at most</strong>, range 58,000 to
            121,000, 74 grids (about 1% apart, since futures maker fees are 0.02%), and a stop loss just outside the
            range. A neutral grid starts flat, goes long as price falls and short as it rises. That is a bet that price
            stays put, and the losing side of that bet grows with every percent price travels.
          </P>
          <Table
            caption="Neutral futures grid, 30-day runs, ±3 sd range, 1% per grid, real funding, 2021–2026"
            head={["Coin", "Median", "Mean", "Worst 5%", "Worst, 1×", "Worst, 2×", "Worst, 5×"]}
            rows={futuresGrid}
          />
          <P>
            The typical month is close to zero and the bad ones are large, and they come from rallies as often as crashes:
            BTC’s worst was a 54% rise in February 2024, XRP’s a 347% rise in November 2024 that took the short side past
            its whole margin. That shape is why leverage is the setting that matters most, and why we would not run this
            bot on altcoins at all.
          </P>
        </section>

        <section aria-labelledby="all-bots">
          <H2 id="all-bots">Every Binance trading bot compared</H2>
          <P>All ten bots on Binance’s Spot and Futures bot menus, where their profit comes from, and our verdict.</P>
          <Table caption="Binance trading bots compared" head={["Bot", "What it does", "Makes money when", "Verdict"]} rows={allBots} />
        </section>

        <section aria-labelledby="set-your-own-range">
          <H2 id="set-your-own-range">How to set the grid range yourself</H2>
          <P>Size the range from the coin’s own volatility, never from a price target:</P>
          <ol className="list-decimal pl-6 space-y-2 text-slate-700 leading-relaxed mb-4">
            <li>Take the coin’s last 90 daily closes and compute the standard deviation of the daily % changes (σ).</li>
            <li>
              Pick how long the grid should run (days) and how wide to go (k): k = 3 for a range price rarely leaves,
              k = 2 for more fills.
            </li>
            <li>
              <strong>Lower = price × e<sup>−k·σ·√days</sup>, upper = price × e<sup>+k·σ·√days</sup>.</strong>
            </li>
            <li>Grids = ln(upper ÷ lower) ÷ ln(1 + spacing), with spacing 1.5% on spot or 1% on futures.</li>
          </ol>
          <P>
            Worked example for BTC on 29 September 2026: σ = 2.24%, 30 days, k = 3 gives e<sup>±0.368</sup>, so
            83,926 × 0.69 = 58,000 and 83,926 × 1.44 = 121,000, with 49 grids at 1.5%. This is the same 90-day window
            our signal engine uses for its own volatility bands. Ranges of 3 standard deviations contained price 98–100%
            of the time on every coin we tested.
          </P>
        </section>

        <section aria-labelledby="methodology">
          <H2 id="methodology">How we tested</H2>
          <ul className="list-disc pl-6 space-y-2 text-slate-700 leading-relaxed mb-4">
            <li>
              <strong>Data:</strong> daily prices from January 2021 to 22 September 2026 for BTC, ETH, SOL, XRP, XLM and
              HBAR; ARB from March 2023 to August 2025; HYPE closes from August 2025. Binance USDⓈ-M funding history for
              all eight. Hourly BTC prices from May to September 2026 to check the daily replay.
            </li>
            <li>
              <strong>Replay:</strong> Binance’s grid mechanics: geometric levels, equal USDT per grid, the grids above
              the price bought at launch, 0.1% per spot fill, 0.02% per futures fill, real funding on futures positions.
              Grids launched every week and ran 30 or 90 days, with ranges of ±1 to ±3 standard deviations and 0.6% to
              3% between grids: 72,280 runs.
            </li>
            <li>
              <strong>Checks:</strong> the same replay on simulated random-walk prices, where the right answer is known;
              hourly against daily bars for BTC; and 16 copies of each coin with every day’s direction flipped at random,
              to separate the market’s behaviour from the replay’s.
            </li>
            <li>
              <strong>Limits:</strong> daily bars miss some intraday fills; slippage is not modelled; trailing up,
              arithmetic mode and Position Snowball were not tested; BNB and HYPE lack full daily bars. Past prices do
              not guarantee future ones.
            </li>
          </ul>
          <P>
            This study is part of the research behind{" "}
            <a href="/signals" className="text-gold-dim underline">Frontier Capital Signals</a>, which publishes a
            directional call only when independent evidence supports one, and says so when it doesn’t.
          </P>
        </section>

        <section aria-labelledby="faq">
          <H2 id="faq">Frequently asked questions</H2>
          <div className="divide-y divide-gray-100 border-y border-gray-100">
            {faqs.map((f) => (
              <details key={f.q} className="group py-4" open>
                <summary className="cursor-pointer list-none flex justify-between gap-4 font-bold text-ink">
                  <h3 className="text-base">{f.q}</h3>
                  <span className="text-gold-dim group-open:rotate-45 transition-transform" aria-hidden>+</span>
                </summary>
                <p className="text-slate-700 leading-relaxed mt-3 text-[15px]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <div className="mt-12 pt-8 border-t border-gray-100">
          <p className="text-slate-600 text-xs leading-relaxed">
            This research is provided for informational purposes only and is not investment advice. Trading bots and
            leveraged derivatives can lose more than you expect, including your entire margin. Frontier Capital Signals
            is not affiliated with Binance. Settings reflect prices on 29 September 2026 and should be recalculated
            before use.
          </p>
        </div>
      </div>
    </article>
  );
}
