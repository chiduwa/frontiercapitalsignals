"use client";

export default function CookieSettingsButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("fcs-open-consent-prefs"))}
      className="text-slate-400 hover:text-white text-xs underline-offset-2 hover:underline transition-colors"
    >
      Cookie Settings
    </button>
  );
}
