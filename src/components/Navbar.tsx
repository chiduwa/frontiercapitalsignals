"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/intelligence", label: "Intelligence" },
  { href: "/markets", label: "Markets" },
  { href: "/services", label: "Services" },
  { href: "/resources", label: "Resources" },
  { href: "/about", label: "About" },
];

export default function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 rounded bg-navy flex items-center justify-center">
              <span className="text-white font-black text-xs tracking-tight">FCS</span>
            </div>
            <div className="hidden sm:block leading-none">
              <span className="font-bold text-ink text-[15px] tracking-tight">Frontier Capital</span>
              <span className="block text-gold text-[10px] font-semibold tracking-widest uppercase mt-0.5">Signals</span>
            </div>
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-0.5">
            {links.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                  pathname === href || pathname.startsWith(href + "/")
                    ? "text-gold bg-amber-50"
                    : "text-slate-600 hover:text-ink hover:bg-gray-50"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            <Link
              href="/contact"
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-navy text-white hover:bg-navy-700 transition-colors"
            >
              Get in Touch
            </Link>
          </div>

          {/* Mobile toggle */}
          <button
            className="md:hidden p-2 rounded text-slate-500 hover:text-ink hover:bg-gray-50"
            onClick={() => setOpen(!open)}
            aria-label="Toggle menu"
          >
            {open ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-gray-100 bg-white px-4 py-3 space-y-1">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={`block px-3 py-2 rounded text-sm font-medium ${
                pathname === href ? "text-gold bg-amber-50" : "text-slate-600 hover:text-ink hover:bg-gray-50"
              }`}
            >
              {label}
            </Link>
          ))}
          <Link
            href="/contact"
            onClick={() => setOpen(false)}
            className="block mt-2 px-3 py-2.5 rounded-lg bg-navy text-white text-sm font-semibold text-center"
          >
            Get in Touch
          </Link>
        </div>
      )}
    </nav>
  );
}
