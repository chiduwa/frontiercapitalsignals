import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

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
    "African market analysis",
    "frontier market investing",
    "Africa due diligence",
    "sub-Saharan Africa investment",
    "African startup ecosystem",
    "infrastructure investment Africa",
  ],
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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="min-h-full flex flex-col bg-navy text-slate-100 antialiased">
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
