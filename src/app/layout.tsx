import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import JsonLd, { organizationSchema, websiteSchema } from "@/components/JsonLd";

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
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Frontier Capital Signals",
    description: "AI-powered emerging market investment intelligence for Africa.",
    images: ["/og-image.png"],
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
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3902425740540825" crossOrigin="anonymous" />
      </head>
      <body className="min-h-full flex flex-col bg-white text-ink antialiased">
        <JsonLd data={organizationSchema} />
        <JsonLd data={websiteSchema} />
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
