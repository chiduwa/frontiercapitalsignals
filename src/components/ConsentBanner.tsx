"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "fcs_consent_v1";
const REOPEN_EVENT = "fcs-open-consent-prefs";

type StoredConsent = { analytics: boolean; advertising: boolean; ts: number };

function readStoredConsent(): StoredConsent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredConsent(analytics: boolean, advertising: boolean) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ analytics, advertising, ts: Date.now() }));
}

function pushConsentUpdate(analytics: boolean, advertising: boolean) {
  const w = window as typeof window & { gtag?: (...args: unknown[]) => void; dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer || [];
  const gtag = w.gtag ?? function (...args: unknown[]) { w.dataLayer!.push(args); };
  gtag("consent", "update", {
    ad_storage: advertising ? "granted" : "denied",
    ad_user_data: advertising ? "granted" : "denied",
    ad_personalization: advertising ? "granted" : "denied",
    analytics_storage: analytics ? "granted" : "denied",
  });
}

export default function ConsentBanner() {
  const [visible, setVisible] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [draftAnalytics, setDraftAnalytics] = useState(false);
  const [draftAdvertising, setDraftAdvertising] = useState(false);

  useEffect(() => {
    const stored = readStoredConsent();
    if (stored) return; // Already chosen — Consent Mode default already reflects it.

    fetch("/api/region")
      .then((res) => res.json())
      .then((data: { requiresConsent: boolean }) => {
        if (data.requiresConsent) {
          setVisible(true);
        } else {
          // Outside the EEA/UK/CH — no explicit opt-in legally required.
          pushConsentUpdate(true, true);
        }
      })
      .catch(() => setVisible(true)); // Fail-safe: show the banner if region lookup fails.
  }, []);

  useEffect(() => {
    const reopen = () => {
      const current = readStoredConsent();
      setDraftAnalytics(current?.analytics ?? false);
      setDraftAdvertising(current?.advertising ?? false);
      setCustomizing(true);
      setVisible(true);
    };
    window.addEventListener(REOPEN_EVENT, reopen);
    return () => window.removeEventListener(REOPEN_EVENT, reopen);
  }, []);

  if (!visible) return null;

  const startCustomizing = () => {
    const current = readStoredConsent();
    setDraftAnalytics(current?.analytics ?? false);
    setDraftAdvertising(current?.advertising ?? false);
    setCustomizing(true);
  };

  const choose = (analytics: boolean, advertising: boolean) => {
    writeStoredConsent(analytics, advertising);
    pushConsentUpdate(analytics, advertising);
    setVisible(false);
    setCustomizing(false);
  };

  return (
    <div className="fixed bottom-11 left-0 right-0 z-[60] px-4 pb-3 sm:px-6">
      <div className="max-w-3xl mx-auto bg-white border border-gray-200 rounded-2xl shadow-2xl shadow-black/20 p-5">
        <p className="text-ink text-sm font-bold mb-1">We value your privacy</p>
        <p className="text-slate-500 text-xs leading-relaxed mb-4">
          We use cookies for analytics and advertising. Choose what you&apos;re comfortable with — you can change this anytime via &ldquo;Cookie Settings&rdquo; in the footer.
        </p>

        {customizing && (
          <div className="space-y-3 mb-4 border-t border-gray-100 pt-4">
            <label className="flex items-center justify-between gap-3 text-sm cursor-pointer">
              <span className="text-ink font-medium">
                Analytics <span className="text-slate-400 font-normal">— helps us understand site usage</span>
              </span>
              <input
                type="checkbox"
                checked={draftAnalytics}
                onChange={(e) => setDraftAnalytics(e.target.checked)}
                className="w-4 h-4 accent-gold shrink-0"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm cursor-pointer">
              <span className="text-ink font-medium">
                Advertising <span className="text-slate-400 font-normal">— personalized ads via AdSense</span>
              </span>
              <input
                type="checkbox"
                checked={draftAdvertising}
                onChange={(e) => setDraftAdvertising(e.target.checked)}
                className="w-4 h-4 accent-gold shrink-0"
              />
            </label>
          </div>
        )}

        <div className="flex flex-wrap gap-2.5">
          <button
            onClick={() => choose(true, true)}
            className="px-4 py-2 rounded-lg bg-navy text-white text-xs font-bold hover:bg-navy-700 transition-colors"
          >
            Accept All
          </button>
          <button
            onClick={() => choose(false, false)}
            className="px-4 py-2 rounded-lg border border-gray-200 text-ink text-xs font-bold hover:bg-sand transition-colors"
          >
            Reject Non-Essential
          </button>
          {customizing ? (
            <button
              onClick={() => choose(draftAnalytics, draftAdvertising)}
              className="px-4 py-2 rounded-lg border border-gold text-gold text-xs font-bold hover:bg-gold hover:text-navy transition-colors"
            >
              Save Preferences
            </button>
          ) : (
            <button
              onClick={startCustomizing}
              className="px-4 py-2 rounded-lg text-slate-500 text-xs font-bold hover:text-ink transition-colors"
            >
              Customize
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
