import Link from "next/link";

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
    <footer className="bg-navy-800 border-t border-navy-600 mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-sm gradient-gold flex items-center justify-center">
                <span className="text-navy font-black text-sm">FC</span>
              </div>
              <div>
                <span className="font-bold text-white text-sm leading-none">Frontier Capital</span>
                <span className="block text-gold text-xs font-semibold tracking-widest uppercase">Signals</span>
              </div>
            </div>
            <p className="text-slate-400 text-sm leading-relaxed">
              AI-powered investment intelligence for Africa's most dynamic emerging markets.
            </p>
            <p className="text-slate-500 text-xs mt-4">
              Ghana · Nigeria · Kenya · Malawi · Uganda
            </p>
          </div>

          {/* Markets */}
          <div>
            <h3 className="text-gold text-xs font-semibold tracking-widest uppercase mb-4">Markets</h3>
            <ul className="space-y-2">
              {countries.map((c) => (
                <li key={c}>
                  <Link href={`/resources#${c.toLowerCase()}`} className="text-slate-400 hover:text-white text-sm transition-colors">
                    {c}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/intelligence" className="text-slate-400 hover:text-white text-sm transition-colors">
                  All Intelligence
                </Link>
              </li>
            </ul>
          </div>

          {/* Services */}
          <div>
            <h3 className="text-gold text-xs font-semibold tracking-widest uppercase mb-4">Services</h3>
            <ul className="space-y-2">
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
            <h3 className="text-gold text-xs font-semibold tracking-widest uppercase mb-4">Company</h3>
            <ul className="space-y-2">
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
              <p className="text-slate-500 text-xs mb-1">Intelligence delivered daily</p>
              <Link
                href="/contact"
                className="inline-block px-4 py-2 text-xs font-semibold rounded border border-gold text-gold hover:bg-gold hover:text-navy transition-colors"
              >
                Request Briefing
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-navy-600 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-slate-500 text-xs">
            &copy; {new Date().getFullYear()} Frontier Capital Signals. All rights reserved.
          </p>
          <p className="text-slate-600 text-xs text-center">
            For informational purposes only. Not financial advice. Always conduct independent due diligence.
          </p>
        </div>
      </div>
    </footer>
  );
}
