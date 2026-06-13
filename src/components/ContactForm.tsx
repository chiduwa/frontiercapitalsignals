"use client";
import { useState } from "react";

export default function ContactForm({ inquiryTypes }: { inquiryTypes: string[] }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [form, setForm] = useState({ name: "", email: "", organization: "", type: "", country: "", message: "" });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    try {
      const res = await fetch("https://formspree.io/f/xqabwjla", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(form),
      });
      setStatus(res.ok ? "sent" : "error");
      if (res.ok) setForm({ name: "", email: "", organization: "", type: "", country: "", message: "" });
    } catch {
      setStatus("error");
    }
  };

  const inputClass = "w-full bg-white border border-gray-200 rounded-lg px-4 py-3 text-ink text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold transition-colors";

  if (status === "sent") {
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
          <label className="block text-ink text-xs font-semibold mb-1.5">Full Name *</label>
          <input name="name" type="text" required value={form.name} onChange={handleChange} placeholder="Your name" className={inputClass} />
        </div>
        <div>
          <label className="block text-ink text-xs font-semibold mb-1.5">Email *</label>
          <input name="email" type="email" required value={form.email} onChange={handleChange} placeholder="you@company.com" className={inputClass} />
        </div>
      </div>
      <div>
        <label className="block text-ink text-xs font-semibold mb-1.5">Organization</label>
        <input name="organization" type="text" value={form.organization} onChange={handleChange} placeholder="Fund, firm, or company name" className={inputClass} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label className="block text-ink text-xs font-semibold mb-1.5">Inquiry Type *</label>
          <select name="type" required value={form.type} onChange={handleChange} className={inputClass}>
            <option value="" disabled>Select inquiry type</option>
            {inquiryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-ink text-xs font-semibold mb-1.5">Country of Interest</label>
          <select name="country" value={form.country} onChange={handleChange} className={inputClass}>
            <option value="">Select country (optional)</option>
            {["Ghana", "Nigeria", "Kenya", "Malawi", "Uganda", "All Markets"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-ink text-xs font-semibold mb-1.5">Message *</label>
        <textarea name="message" required value={form.message} onChange={handleChange} rows={5}
          placeholder="Describe your mandate, question, or what you're looking for..."
          className={`${inputClass} resize-none`} />
      </div>
      {status === "error" && <p className="text-red-600 text-sm">Something went wrong. Please try again.</p>}
      <button type="submit" disabled={status === "sending"}
        className="w-full py-3.5 rounded-lg bg-navy text-white font-bold text-sm hover:bg-navy-700 transition-colors disabled:opacity-50">
        {status === "sending" ? "Sending..." : "Send Message"}
      </button>
      <p className="text-slate-400 text-xs text-center">No spam, ever. We&apos;ll only respond to your inquiry.</p>
    </form>
  );
}
