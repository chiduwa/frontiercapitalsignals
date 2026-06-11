"use client";
import { useState } from "react";

export default function ContactForm({ inquiryTypes }: { inquiryTypes: string[] }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [form, setForm] = useState({
    name: "", email: "", organization: "", type: "", country: "", message: "",
  });

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
      if (res.ok) {
        setStatus("sent");
        setForm({ name: "", email: "", organization: "", type: "", country: "", message: "" });
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  const inputClass = "w-full bg-navy border border-navy-600 rounded-lg px-4 py-3 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-gold transition-colors";

  if (status === "sent") {
    return (
      <div className="bg-navy-800 border border-emerald-fcs/30 rounded-2xl p-10 text-center">
        <div className="text-5xl mb-4">✅</div>
        <h3 className="text-white font-black text-xl mb-2">Message Received</h3>
        <p className="text-slate-400 text-sm">
          Thank you for reaching out. We&apos;ll respond within one business day.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-navy-800 border border-navy-600 rounded-2xl p-8 space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label className="block text-slate-400 text-xs font-semibold mb-1.5">Full Name *</label>
          <input name="name" type="text" required value={form.name} onChange={handleChange} placeholder="Your name" className={inputClass} />
        </div>
        <div>
          <label className="block text-slate-400 text-xs font-semibold mb-1.5">Email *</label>
          <input name="email" type="email" required value={form.email} onChange={handleChange} placeholder="you@company.com" className={inputClass} />
        </div>
      </div>
      <div>
        <label className="block text-slate-400 text-xs font-semibold mb-1.5">Organization</label>
        <input name="organization" type="text" value={form.organization} onChange={handleChange} placeholder="Fund, firm, or company name" className={inputClass} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label className="block text-slate-400 text-xs font-semibold mb-1.5">Inquiry Type *</label>
          <select name="type" required value={form.type} onChange={handleChange} className={inputClass}>
            <option value="" disabled>Select inquiry type</option>
            {inquiryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 text-xs font-semibold mb-1.5">Country of Interest</label>
          <select name="country" value={form.country} onChange={handleChange} className={inputClass}>
            <option value="">Select country (optional)</option>
            {["Ghana", "Nigeria", "Kenya", "Malawi", "Uganda", "All Markets"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-slate-400 text-xs font-semibold mb-1.5">Message *</label>
        <textarea
          name="message" required value={form.message} onChange={handleChange}
          rows={5} placeholder="Describe your mandate, question, or what you're looking for..."
          className={`${inputClass} resize-none`}
        />
      </div>

      {status === "error" && (
        <p className="text-red-400 text-sm">Something went wrong. Please try again or email us directly.</p>
      )}

      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full py-3 rounded-lg gradient-gold text-navy font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {status === "sending" ? "Sending..." : "Send Message"}
      </button>

      <p className="text-slate-600 text-xs text-center">
        By submitting, you agree that we may contact you regarding your inquiry. No spam, ever.
      </p>
    </form>
  );
}
