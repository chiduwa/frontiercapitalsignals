import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import MarketTicker from "@/components/MarketTicker";
import JsonLd, { organizationSchema, websiteSchema } from "@/components/JsonLd";
import ConsentBanner from "@/components/ConsentBanner";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  metadataBase: new URL("https://frontiercapitalsignals.com"),
  title: {
    default: "Frontier Capital Signals | AI-Powered African Market Intelligence",
    template: "%s | Frontier Capital Signals",
  },
  description:
    "AI-powered investment intelligence for Ghana, Nigeria, Kenya, Malawi, and Uganda. Daily market insights, due diligence support, and on-ground intelligence for emerging market investors.",
  keywords: [
    "Africa investment intelligence",
    "emerging market research",
    "Ghana investment opportunities",
    "Nigeria business intelligence",
    "Kenya FDI",
    "Malawi investment",
    "Uganda investment",
    "African market analysis",
    "frontier market investing",
    "Africa due diligence",
    "sub-Saharan Africa investment",
    "African startup ecosystem",
    "infrastructure investment Africa",
    "Africa PPP opportunities",
    "African private equity",
    "emerging Africa markets 2025",
    "invest in Africa",
    "Africa business intelligence",
  ],
  alternates: { canonical: "https://frontiercapitalsignals.com" },
  authors: [{ name: "Frontier Capital Signals" }],
  creator: "Frontier Capital Signals",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://frontiercapitalsignals.com",
    siteName: "Frontier Capital Signals",
    title: "Frontier Capital Signals | AI-Powered African Market Intelligence",
    description:
      "Daily AI-curated investment intelligence for Ghana, Nigeria, Kenya, Malawi, and Uganda. Unlock opportunities invisible to global investors.",
    images: [
      {
        url: "https://frontiercapitalsignals.com/og-image.png",
        width: 1200,
        height: 630,
        alt: "Frontier Capital Signals — AI-Powered African Market Intelligence",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Frontier Capital Signals",
    description: "AI-powered emerging market investment intelligence for Africa.",
    images: ["https://frontiercapitalsignals.com/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  other: {
    "google-adsense-account": "ca-pub-3902425740540825",
    "geo.region": "GH, NG, KE, MW, UG",
    "geo.placename": "Ghana, Nigeria, Kenya, Malawi, Uganda",
    "ICBM": "7.9465, -1.0232",
    "DC.language": "en",
    "DC.coverage": "Ghana, Nigeria, Kenya, Malawi, Uganda, Sub-Saharan Africa",
    "DC.subject": "Investment Intelligence, Emerging Markets, Africa Finance",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <head>
        {/* Consent Mode v2 defaults — must run before GTM/gtag/AdSense load.
            Everyone defaults to denied until ConsentBanner resolves: either the
            visitor's own prior choice (localStorage), or an automatic grant for
            visitors outside the EEA/UK/CH (see /api/region + ConsentBanner.tsx). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
window.gtag=window.gtag||gtag;
var stored=null;
try{stored=JSON.parse(localStorage.getItem('fcs_consent_v1'));}catch(e){}
if(stored){
gtag('consent','default',{
ad_storage:stored.advertising?'granted':'denied',
ad_user_data:stored.advertising?'granted':'denied',
ad_personalization:stored.advertising?'granted':'denied',
analytics_storage:stored.analytics?'granted':'denied'
});
}else{
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});
}
})();`,
          }}
        />
        {/* Google Tag Manager */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-5Q7JC6JX');`,
          }}
        />
        {/* End Google Tag Manager */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3902425740540825" crossOrigin="anonymous" />
        {/* Google tag (gtag.js) */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-VT7WHK310R" />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-VT7WHK310R');`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-white text-ink antialiased pb-11">
        {/* Google Tag Manager (noscript) */}
        <noscript>
          <iframe
            src="https://www.googletagmanager.com/ns.html?id=GTM-5Q7JC6JX"
            height="0"
            width="0"
            style={{ display: "none", visibility: "hidden" }}
          />
        </noscript>
        {/* End Google Tag Manager (noscript) */}
        <JsonLd data={organizationSchema} />
        <JsonLd data={websiteSchema} />
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
        <MarketTicker />
        <ConsentBanner />
      </body>
    </html>
  );
}
