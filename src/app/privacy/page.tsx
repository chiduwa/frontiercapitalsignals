import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy & Cookies",
  description: "What Frontier Capital Signals collects through its forms, site scan, analytics and ads, how cookie consent works by region, and how to change your choice.",
  alternates: { canonical: "https://frontiercapitalsignals.com/privacy" },
  openGraph: { url: "https://frontiercapitalsignals.com/privacy", type: "website", images: [{ url: "/opengraph-image", width: 1200, height: 630 }] },
};

// Keep this page in step with what the site actually does: ConsentBanner.tsx and
// /api/region (who sees the banner, what is granted elsewhere), layout.tsx
// (GTM, AdSense, Consent Mode defaults), the Formspree forms and /api/scan.
const sections: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: "collect",
    title: "What we collect and why",
    body: (
      <ul className="list-disc pl-5 space-y-3">
        <li>
          <strong className="text-ink">Enquiries.</strong> The contact and audit request forms send us your name, email
          address and message, plus your organisation, enquiry type and country (contact form) or website and chosen
          package (audit form). They reach us through Formspree, a form-delivery service. We use them to reply and to
          deliver what you asked for, and we do not sell them.
        </li>
        <li>
          <strong className="text-ink">Free site scan.</strong> Our server fetches the web address you enter, runs the
          checks and shows you the results. We do not store the address or the results. To stop abuse, the server
          briefly counts scans from each connection over the last minute.
        </li>
        <li>
          <strong className="text-ink">Analytics.</strong> Google Analytics 4, loaded through Google Tag Manager, tells
          us which pages are read and how visitors arrive, so we can see what is useful.
        </li>
        <li>
          <strong className="text-ink">Advertising.</strong> Google AdSense shows ads on the site. Where you allow it,
          those ads can be personalised. Google and its partners use cookies to serve and measure them; see{" "}
          <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer" className="text-gold-dim font-semibold underline underline-offset-2 hover:text-gold-ink">
            how Google uses information from sites that use its services
          </a>.
        </li>
        <li>
          <strong className="text-ink">Hosting and security.</strong> Cloudflare serves the site. Like any web host it
          processes your IP address to deliver pages and block attacks, and it tells us your country, which is how we
          know whether to ask for cookie consent.
        </li>
        <li>
          <strong className="text-ink">Stored on your device only.</strong> Your cookie choice and the layout of the
          signals panels are saved in your browser&apos;s local storage. They are not sent to us.
        </li>
      </ul>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and your choices",
    body: (
      <>
        <p>
          A first visit starts with analytics and advertising storage switched off. What happens next depends on where
          you are; after that, your saved choice applies.
        </p>
        <ul className="list-disc pl-5 space-y-2 mt-3">
          <li>
            <strong className="text-ink">In the EEA, the UK and Switzerland</strong>, nothing is switched on until you
            choose on the cookie banner. You can accept all, reject all, or pick analytics and advertising separately.
          </li>
          <li>
            <strong className="text-ink">Everywhere else</strong>, analytics and advertising (including personalised
            ads) are switched on automatically and no banner is shown.
          </li>
        </ul>
        <p className="mt-3">
          Wherever you are, <strong className="text-ink">Cookie Settings</strong> at the bottom of every page lets you
          turn either one off, or back on, at any time. You can also manage Google ad personalisation in{" "}
          <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer" className="text-gold-dim font-semibold underline underline-offset-2 hover:text-gold-ink">
            Google&apos;s ad settings
          </a>.
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "Keeping and deleting your information",
    body: (
      <p>
        We keep enquiries for as long as we need them to answer and follow up. You can ask what we hold about you, or
        ask us to correct or delete it, through the{" "}
        <Link href="/contact" className="text-gold-dim font-semibold underline underline-offset-2 hover:text-gold-ink">contact form</Link>.
        If you are in the EEA or the UK you can also complain to your data protection authority.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: <p>When this policy changes we update the date at the top of the page.</p>,
  },
];

export default function PrivacyPage() {
  return (
    <>
      <section className="bg-sand border-b border-gray-200 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Privacy</p>
            <h1 className="text-4xl font-black text-ink mb-4 tracking-tight">Privacy &amp; Cookies</h1>
            <p className="text-slate-600 text-sm">Last updated 15 October 2026.</p>
          </div>
        </div>
      </section>

      <section className="py-14 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12 text-slate-700 text-[15px] leading-relaxed">
          <p>
            Frontier Capital Signals publishes investment intelligence on Ghana, Nigeria, Kenya, Malawi and Uganda at
            frontiercapitalsignals.com. This page explains what information the site collects, why, and the choices
            you have.
          </p>
          {sections.map((s) => (
            <div key={s.id} id={s.id}>
              <h2 className="text-xl font-bold text-ink mb-3">{s.title}</h2>
              {s.body}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
