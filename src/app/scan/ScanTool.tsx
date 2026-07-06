"use client";
import { useState } from "react";
import Link from "next/link";
import { pushDataLayerEvent } from "@/lib/analytics";

interface Check {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  points: number;
  maxPoints: number;
}
interface ScanResult {
  url: string;
  score: number;
  grade: string;
  checks: Check[];
}

const statusStyle: Record<Check["status"], string> = {
  pass: "text-green-600 bg-green-50 border-green-200",
  warn: "text-amber-600 bg-amber-50 border-amber-200",
  fail: "text-red-600 bg-red-50 border-red-200",
};
const statusIcon: Record<Check["status"], string> = { pass: "✓", warn: "!", fail: "✕" };

export default function ScanTool({ prefillUrl }: { prefillUrl?: string }) {
  const [url, setUrl] = useState(prefillUrl ?? "");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("loading");
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
      pushDataLayerEvent("ai_visibility_scan_completed", { scanned_url: data.url, score: data.score });
    } catch {
      setError("Something went wrong. Try again in a moment.");
      setStatus("error");
    }
  };

  const scoreColor = result ? (result.score >= 80 ? "text-green-600" : result.score >= 50 ? "text-amber-600" : "text-red-600") : "";

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 mb-10">
        <input
          type="text"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="yourbusiness.com"
          className="flex-1 bg-white border border-gray-200 rounded-lg px-4 py-3.5 text-ink text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold transition-colors"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="px-8 py-3.5 rounded-lg gradient-gold text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
        >
          {status === "loading" ? "Scanning…" : "Run Free Scan"}
        </button>
      </form>

      {status === "error" && (
        <p className="text-red-600 text-sm mb-8">{error}</p>
      )}

      {result && (
        <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8 pb-8 border-b border-gray-200">
            <div>
              <p className="text-slate-500 text-xs mb-1">Results for</p>
              <p className="text-ink font-bold break-all">{result.url}</p>
            </div>
            <div className="text-right shrink-0">
              <p className={`text-5xl font-black tabular-nums ${scoreColor}`}>{result.score}</p>
              <p className="text-slate-500 text-xs font-semibold tracking-widest uppercase mt-1">{result.grade}</p>
            </div>
          </div>

          <ul className="space-y-3">
            {result.checks.map((c) => (
              <li key={c.id} className={`border rounded-xl p-4 ${statusStyle[c.status]}`}>
                <div className="flex items-start gap-3">
                  <span className="font-black text-sm mt-0.5 shrink-0">{statusIcon[c.status]}</span>
                  <div>
                    <p className="font-bold text-sm text-ink">{c.label}</p>
                    <p className="text-sm mt-0.5 opacity-90">{c.detail}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-8 pt-8 border-t border-gray-200 bg-sand -mx-8 -mb-8 px-8 pb-8 rounded-b-2xl">
            <p className="text-ink font-bold mb-2">This scan is automated and directional.</p>
            <p className="text-slate-500 text-sm mb-5">
              A full audit checks Search Console indexing, consent/tag configuration, and content structure in depth, then we implement every fix — not just diagnose it.
            </p>
            <Link href="/audit#pricing" className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-navy text-white font-bold text-sm hover:bg-navy-700 transition-colors">
              See the Full Audit + Fix
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
