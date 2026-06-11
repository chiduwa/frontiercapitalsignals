import type { Metadata } from "next";
import ContactForm from "@/components/ContactForm";

export const metadata: Metadata = {
  title: "Contact Us",
  description:
    "Get in touch with Frontier Capital Signals. Request a market briefing, discuss your investment mandate, or inquire about our services for Africa.",
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
      <section className="bg-navy-800 border-b border-navy-600 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-3">Get in Touch</p>
          <h1 className="text-4xl font-black text-white mb-4">Start the Conversation</h1>
          <p className="text-slate-400 max-w-xl mx-auto">
            Whether you&apos;re an institutional investor, a family office, or a company exploring African markets — tell us what you&apos;re looking for and we&apos;ll respond within one business day.
          </p>
        </div>
      </section>

      <section className="py-16 bg-navy min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-12">
            {/* Left info */}
            <div className="lg:col-span-2 space-y-8">
              <div>
                <h2 className="text-xl font-bold text-white mb-4">What Happens Next</h2>
                <ol className="space-y-4">
                  {[
                    "We review your inquiry and match it to the right team member.",
                    "You receive a response within one business day with next steps.",
                    "For intelligence briefs, we send a sample within 48 hours.",
                    "For engagements, we schedule a scoping call to understand your mandate.",
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="w-6 h-6 rounded-full gradient-gold text-navy text-xs font-black flex items-center justify-center shrink-0 mt-0.5">
                        {i + 1}
                      </span>
                      <p className="text-slate-300 text-sm leading-relaxed">{step}</p>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="bg-navy-800 border border-navy-600 rounded-xl p-6">
                <h3 className="text-white font-bold mb-4">Inquiry Types</h3>
                <ul className="space-y-2">
                  {inquiryTypes.map((t) => (
                    <li key={t} className="flex items-center gap-2 text-slate-400 text-sm">
                      <svg className="w-4 h-4 text-gold shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-navy-800 border border-gold/20 rounded-xl p-6">
                <p className="text-gold text-xs font-semibold tracking-widest uppercase mb-2">Response Time</p>
                <p className="text-white font-bold text-2xl mb-1">&lt; 24 hours</p>
                <p className="text-slate-400 text-sm">on all inquiries, Monday to Friday</p>
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
