import type { Metadata } from "next";
import ContactForm from "@/components/ContactForm";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Get in touch with Frontier Capital Signals. Request a market briefing, discuss your investment mandate, or book an Africa market consultation.",
  alternates: { canonical: "https://frontiercapitalsignals.com/contact" },
  keywords: ["Africa market briefing", "invest in Africa consultation", "Africa investment advisor contact", "frontier market research request"],
  openGraph: { url: "https://frontiercapitalsignals.com/contact", type: "website" },
};

const inquiryTypes = [
  "Request a market intelligence brief",
  "Discuss an investment mandate",
  "Due diligence engagement",
  "Market entry strategy",
  "Field research project",
  "Partnership inquiry",
  "Media / press",
  "Other",
];

export default function ContactPage() {
  return (
    <>
      <section className="bg-sand border-b border-gray-200 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-gold-dim text-xs font-semibold tracking-widest uppercase mb-3">Get in Touch</p>
            <h1 className="text-5xl font-black text-ink mb-4 tracking-tight">Start the Conversation</h1>
            <p className="text-slate-500 text-lg">
              Whether you&apos;re an institutional investor, a family office, or a company exploring African markets — tell us what you&apos;re looking for.
            </p>
          </div>
        </div>
      </section>

      <section className="py-16 bg-white min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-12">
            {/* Left */}
            <div className="lg:col-span-2 space-y-8">
              <div>
                <h2 className="text-lg font-bold text-ink mb-5">What Happens Next</h2>
                <ol className="space-y-4">
                  {[
                    "We review your inquiry and match it to the right team member.",
                    "You receive a response within one business day.",
                    "For intelligence briefs, we send a sample within 48 hours.",
                    "For engagements, we schedule a scoping call to understand your mandate.",
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="w-7 h-7 rounded-full bg-navy text-white text-xs font-black flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                      <p className="text-slate-500 text-sm leading-relaxed">{step}</p>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="bg-sand border border-gray-200 rounded-xl p-6">
                <h3 className="text-ink font-bold mb-4 text-sm">Inquiry Types We Handle</h3>
                <ul className="space-y-2">
                  {inquiryTypes.map((t) => (
                    <li key={t} className="flex items-center gap-2 text-slate-500 text-sm">
                      <svg className="w-4 h-4 text-gold shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-navy rounded-xl p-6">
                <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-2">Response Time</p>
                <p className="text-white font-black text-3xl mb-1">&lt; 24 hrs</p>
                <p className="text-white/50 text-sm">on all inquiries, Monday to Friday</p>
              </div>
            </div>

            {/* Form */}
            <div className="lg:col-span-3">
              <ContactForm inquiryTypes={inquiryTypes} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
