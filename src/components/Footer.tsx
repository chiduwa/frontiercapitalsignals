import Link from "next/link";
import CookieSettingsButton from "@/components/CookieSettingsButton";

const countries = ["Ghana", "Nigeria", "Kenya", "Malawi", "Uganda"];
const services = [
  { label: "Investment Intelligence", href: "/services#intelligence" },
  { label: "Due Diligence", href: "/services#due-diligence" },
  { label: "Market Entry Strategy", href: "/services#market-entry" },
  { label: "Deal Origination", href: "/services#deal-origination" },
  { label: "Field Research", href: "/services#field-research" },
];

export default function Footer() {
  return (
    <footer className="bg-navy border-t border-navy-700 mt-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center">
                <span className="text-white font-black text-xs">FCS</span>
              </div>
              <div className="leading-none">
                <span className="font-bold text-white text-sm">Frontier Capital</span>
                <span className="block text-gold text-[10px] font-semibold tracking-widest uppercase mt-0.5">Signals</span>
              </div>
            </div>
            <p className="text-slate-400 text-sm leading-relaxed">
              AI-powered investment intelligence for Africa&apos;s most dynamic emerging markets.
            </p>
            <p className="text-slate-400 text-xs mt-4 font-medium tracking-wide">
              GH &middot; NG &middot; KE &middot; MWI &middot; UG
            </p>
          </div>

          {/* Markets */}
          <div>
            <h3 className="text-white text-xs font-semibold tracking-widest uppercase mb-4">Markets</h3>
            <ul className="space-y-2.5">
              {countries.map((c) => (
                <li key={c}>
                  <Link href={`/resources#${c.toLowerCase()}`} className="text-slate-400 hover:text-white text-sm transition-colors">
                    {c}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Services */}
          <div>
            <h3 className="text-white text-xs font-semibold tracking-widest uppercase mb-4">Services</h3>
            <ul className="space-y-2.5">
              {services.map(({ label, href }) => (
                <li key={label}>
                  <Link href={href} className="text-slate-400 hover:text-white text-sm transition-colors">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-white text-xs font-semibold tracking-widest uppercase mb-4">Company</h3>
            <ul className="space-y-2.5">
              {[
                { label: "About Us", href: "/about" },
                { label: "Intelligence Feed", href: "/intelligence" },
                { label: "Investor Resources", href: "/resources" },
                { label: "Contact", href: "/contact" },
              ].map(({ label, href }) => (
                <li key={label}>
                  <Link href={href} className="text-slate-400 hover:text-white text-sm transition-colors">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <Link
                href="/contact"
                className="inline-block px-4 py-2 text-xs font-semibold rounded-lg border border-gold/50 text-gold hover:bg-gold hover:text-navy transition-colors"
              >
                Request Briefing
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-white/10 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-slate-400 text-xs">
            &copy; {new Date().getFullYear()} Frontier Capital Signals. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <p className="text-slate-400 text-xs text-center">
              For informational purposes only. Not financial advice.
            </p>
            <CookieSettingsButton />
          </div>
        </div>
      </div>
    </footer>
  );
}
