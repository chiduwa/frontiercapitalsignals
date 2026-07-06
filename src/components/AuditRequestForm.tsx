"use client";
import { useState } from "react";
import { pushDataLayerEvent } from "@/lib/analytics";

const packages = ["Standard Fix — $349", "Full AI Visibility Package — $599", "Not sure yet — advise me"];

export default function AuditRequestForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [form, setForm] = useState({ name: "", email: "", website: "", package: "", message: "" });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    try {
      const res = await fetch("https://formspree.io/f/xgoblzje", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...form, _subject: `AI Visibility Audit request: ${form.website}`, source: "ai-visibility-audit" }),
      });
      if (res.ok) {
        setStatus("sent");
        pushDataLayerEvent("audit_request_submit", { package: form.package });
        setForm({ name: "", email: "", website: "", package: "", message: "" });
      } else {
        setStatus("error");
      }
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
        <h3 className="text-ink font-black text-xl mb-2">Request Received</h3>
        <p className="text-slate-600 text-sm">We&apos;ll follow up within one business day with next steps.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label htmlFor="name" className="block text-ink text-xs font-semibold mb-1.5">Name *</label>
          <input id="name" name="name" type="text" required value={form.name} onChange={handleChange} placeholder="Your name" className={inputClass} />
        </div>
        <div>
          <label htmlFor="email" className="block text-ink text-xs font-semibold mb-1.5">Email *</label>
          <input id="email" name="email" type="email" required value={form.email} onChange={handleChange} placeholder="you@business.com" className={inputClass} />
        </div>
      </div>
      <div>
        <label htmlFor="website" className="block text-ink text-xs font-semibold mb-1.5">Website URL *</label>
        <input id="website" name="website" type="text" required value={form.website} onChange={handleChange} placeholder="yourbusiness.com" className={inputClass} />
      </div>
      <div>
        <label htmlFor="package" className="block text-ink text-xs font-semibold mb-1.5">Package *</label>
        <select id="package" name="package" required value={form.package} onChange={handleChange} className={inputClass}>
          <option value="" disabled>Select a package</option>
          {packages.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="message" className="block text-ink text-xs font-semibold mb-1.5">Anything we should know?</label>
        <textarea id="message" name="message" value={form.message} onChange={handleChange} rows={4}
          placeholder="Optional — what prompted you to look into this?"
          className={`${inputClass} resize-none`} />
      </div>
      <input type="text" name="_gotcha" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ display: "none" }} />
      {status === "error" && (
        <p className="text-red-600 text-sm">Submission failed — please try again in a moment.</p>
      )}
      <button type="submit" disabled={status === "sending"}
        className="w-full py-3.5 rounded-lg bg-navy text-white font-bold text-sm hover:bg-navy-700 transition-colors disabled:opacity-50">
        {status === "sending" ? "Sending…" : "Request This Package"}
      </button>
    </form>
  );
}
