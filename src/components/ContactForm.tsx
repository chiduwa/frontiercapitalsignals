"use client";
import { useForm, ValidationError } from "@formspree/react";

export default function ContactForm({ inquiryTypes }: { inquiryTypes: string[] }) {
  const [state, handleSubmit] = useForm("xgoblzje");

  const inputClass =
    "w-full bg-white border border-gray-200 rounded-lg px-4 py-3 text-ink text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold transition-colors";

  if (state.succeeded) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center shadow-sm">
        <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-ink font-black text-xl mb-2">Message Received</h3>
        <p className="text-slate-500 text-sm">We&apos;ll respond within one business day.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label htmlFor="name" className="block text-ink text-xs font-semibold mb-1.5">Full Name *</label>
          <input id="name" name="name" type="text" required placeholder="Your name" className={inputClass} />
          <ValidationError field="name" errors={state.errors} className="text-red-600 text-xs mt-1 block" />
        </div>
        <div>
          <label htmlFor="email" className="block text-ink text-xs font-semibold mb-1.5">Email *</label>
          <input id="email" name="email" type="email" required placeholder="you@company.com" className={inputClass} />
          <ValidationError field="email" errors={state.errors} className="text-red-600 text-xs mt-1 block" />
        </div>
      </div>
      <div>
        <label htmlFor="organization" className="block text-ink text-xs font-semibold mb-1.5">Organization</label>
        <input id="organization" name="organization" type="text" placeholder="Fund, firm, or company name" className={inputClass} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label htmlFor="type" className="block text-ink text-xs font-semibold mb-1.5">Inquiry Type *</label>
          <select id="type" name="type" required defaultValue="" className={inputClass}>
            <option value="" disabled>Select inquiry type</option>
            {inquiryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <ValidationError field="type" errors={state.errors} className="text-red-600 text-xs mt-1 block" />
        </div>
        <div>
          <label htmlFor="country" className="block text-ink text-xs font-semibold mb-1.5">Country of Interest</label>
          <select id="country" name="country" defaultValue="" className={inputClass}>
            <option value="">Select country (optional)</option>
            {["Ghana", "Nigeria", "Kenya", "Malawi", "Uganda", "All Markets"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="message" className="block text-ink text-xs font-semibold mb-1.5">Message *</label>
        <textarea id="message" name="message" required rows={5}
          placeholder="Describe your mandate, question, or what you're looking for..."
          className={`${inputClass} resize-none`} />
        <ValidationError field="message" errors={state.errors} className="text-red-600 text-xs mt-1 block" />
      </div>
      <ValidationError errors={state.errors} className="text-red-600 text-sm block" />
      <button
        type="submit"
        disabled={state.submitting}
        className="w-full py-3.5 rounded-lg bg-navy text-white font-bold text-sm hover:bg-navy-700 transition-colors disabled:opacity-50"
      >
        {state.submitting ? "Sending…" : "Send Message"}
      </button>
      <p className="text-slate-400 text-xs text-center">No spam, ever. We&apos;ll only respond to your inquiry.</p>
    </form>
  );
}
