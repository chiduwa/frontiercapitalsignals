"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";

// ── Priority ordering ──────────────────────────────────────────────────────────
// These appear at the top of every list and are the only currencies in the ticker strip
const FOCUS_MARKET_CODES  = ["GHS", "NGN", "KES", "MWK", "UGX"];
const MAJOR_GLOBAL_CODES  = ["USD", "EUR", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD", "HKD", "SGD", "NZD", "ZAR", "SAR", "AED"];
const PRIORITY_CODES      = [...FOCUS_MARKET_CODES, ...MAJOR_GLOBAL_CODES];

// Ticker strip shows only focus + key global currencies (no commodities in currency slots)
const TICKER_CURRENCY_CODES = ["GHS", "NGN", "KES", "MWK", "UGX", "EUR", "GBP", "CNY", "JPY", "ZAR"];

// ── Comprehensive currency metadata ───────────────────────────────────────────
const CURRENCY_META: Record<string, { name: string; flag: string; symbol?: string }> = {
  AED: { name: "UAE Dirham",              flag: "🇦🇪", symbol: "د.إ" },
  AFN: { name: "Afghan Afghani",          flag: "🇦🇫", symbol: "؋"  },
  ALL: { name: "Albanian Lek",            flag: "🇦🇱", symbol: "L"  },
  AMD: { name: "Armenian Dram",           flag: "🇦🇲", symbol: "֏"  },
  ANG: { name: "Netherlands Antillean Guilder", flag: "🇨🇼", symbol: "ƒ" },
  AOA: { name: "Angolan Kwanza",          flag: "🇦🇴", symbol: "Kz" },
  ARS: { name: "Argentine Peso",          flag: "🇦🇷", symbol: "$"  },
  AUD: { name: "Australian Dollar",       flag: "🇦🇺", symbol: "$"  },
  AWG: { name: "Aruban Florin",           flag: "🇦🇼", symbol: "ƒ"  },
  AZN: { name: "Azerbaijani Manat",       flag: "🇦🇿", symbol: "₼"  },
  BAM: { name: "Bosnia-Herzegovina Convertible Mark", flag: "🇧🇦", symbol: "KM" },
  BBD: { name: "Barbadian Dollar",        flag: "🇧🇧", symbol: "$"  },
  BDT: { name: "Bangladeshi Taka",        flag: "🇧🇩", symbol: "৳"  },
  BGN: { name: "Bulgarian Lev",           flag: "🇧🇬", symbol: "лв" },
  BHD: { name: "Bahraini Dinar",          flag: "🇧🇭", symbol: "BD" },
  BIF: { name: "Burundian Franc",         flag: "🇧🇮", symbol: "Fr" },
  BMD: { name: "Bermudan Dollar",         flag: "🇧🇲", symbol: "$"  },
  BND: { name: "Brunei Dollar",           flag: "🇧🇳", symbol: "$"  },
  BOB: { name: "Bolivian Boliviano",      flag: "🇧🇴", symbol: "Bs" },
  BRL: { name: "Brazilian Real",          flag: "🇧🇷", symbol: "R$" },
  BSD: { name: "Bahamian Dollar",         flag: "🇧🇸", symbol: "$"  },
  BTN: { name: "Bhutanese Ngultrum",      flag: "🇧🇹", symbol: "Nu" },
  BWP: { name: "Botswana Pula",           flag: "🇧🇼", symbol: "P"  },
  BYN: { name: "Belarusian Ruble",        flag: "🇧🇾", symbol: "Br" },
  BZD: { name: "Belize Dollar",           flag: "🇧🇿", symbol: "$"  },
  CAD: { name: "Canadian Dollar",         flag: "🇨🇦", symbol: "$"  },
  CDF: { name: "Congolese Franc",         flag: "🇨🇩", symbol: "Fr" },
  CHF: { name: "Swiss Franc",             flag: "🇨🇭", symbol: "Fr" },
  CLP: { name: "Chilean Peso",            flag: "🇨🇱", symbol: "$"  },
  CNY: { name: "Chinese Yuan",            flag: "🇨🇳", symbol: "¥"  },
  COP: { name: "Colombian Peso",          flag: "🇨🇴", symbol: "$"  },
  CRC: { name: "Costa Rican Colón",       flag: "🇨🇷", symbol: "₡"  },
  CUP: { name: "Cuban Peso",              flag: "🇨🇺", symbol: "$"  },
  CVE: { name: "Cape Verdean Escudo",     flag: "🇨🇻", symbol: "$"  },
  CZK: { name: "Czech Koruna",            flag: "🇨🇿", symbol: "Kč" },
  DJF: { name: "Djiboutian Franc",        flag: "🇩🇯", symbol: "Fr" },
  DKK: { name: "Danish Krone",            flag: "🇩🇰", symbol: "kr" },
  DOP: { name: "Dominican Peso",          flag: "🇩🇴", symbol: "$"  },
  DZD: { name: "Algerian Dinar",          flag: "🇩🇿", symbol: "دج" },
  EGP: { name: "Egyptian Pound",          flag: "🇪🇬", symbol: "£"  },
  ERN: { name: "Eritrean Nakfa",          flag: "🇪🇷", symbol: "Nfk"},
  ETB: { name: "Ethiopian Birr",          flag: "🇪🇹", symbol: "Br" },
  EUR: { name: "Euro",                    flag: "🇪🇺", symbol: "€"  },
  FJD: { name: "Fijian Dollar",           flag: "🇫🇯", symbol: "$"  },
  FKP: { name: "Falkland Islands Pound",  flag: "🇫🇰", symbol: "£"  },
  GBP: { name: "British Pound",           flag: "🇬🇧", symbol: "£"  },
  GEL: { name: "Georgian Lari",           flag: "🇬🇪", symbol: "₾"  },
  GHS: { name: "Ghanaian Cedi",           flag: "🇬🇭", symbol: "₵"  },
  GIP: { name: "Gibraltar Pound",         flag: "🇬🇮", symbol: "£"  },
  GMD: { name: "Gambian Dalasi",          flag: "🇬🇲", symbol: "D"  },
  GNF: { name: "Guinean Franc",           flag: "🇬🇳", symbol: "Fr" },
  GTQ: { name: "Guatemalan Quetzal",      flag: "🇬🇹", symbol: "Q"  },
  GYD: { name: "Guyanese Dollar",         flag: "🇬🇾", symbol: "$"  },
  HKD: { name: "Hong Kong Dollar",        flag: "🇭🇰", symbol: "$"  },
  HNL: { name: "Honduran Lempira",        flag: "🇭🇳", symbol: "L"  },
  HRK: { name: "Croatian Kuna",           flag: "🇭🇷", symbol: "kn" },
  HTG: { name: "Haitian Gourde",          flag: "🇭🇹", symbol: "G"  },
  HUF: { name: "Hungarian Forint",        flag: "🇭🇺", symbol: "Ft" },
  IDR: { name: "Indonesian Rupiah",       flag: "🇮🇩", symbol: "Rp" },
  ILS: { name: "Israeli Shekel",          flag: "🇮🇱", symbol: "₪"  },
  INR: { name: "Indian Rupee",            flag: "🇮🇳", symbol: "₹"  },
  IQD: { name: "Iraqi Dinar",             flag: "🇮🇶", symbol: "ع.د"},
  IRR: { name: "Iranian Rial",            flag: "🇮🇷", symbol: "﷼"  },
  ISK: { name: "Icelandic Króna",         flag: "🇮🇸", symbol: "kr" },
  JMD: { name: "Jamaican Dollar",         flag: "🇯🇲", symbol: "$"  },
  JOD: { name: "Jordanian Dinar",         flag: "🇯🇴", symbol: "JD" },
  JPY: { name: "Japanese Yen",            flag: "🇯🇵", symbol: "¥"  },
  KES: { name: "Kenyan Shilling",         flag: "🇰🇪", symbol: "KSh"},
  KGS: { name: "Kyrgyzstani Som",         flag: "🇰🇬", symbol: "лв" },
  KHR: { name: "Cambodian Riel",          flag: "🇰🇭", symbol: "៛"  },
  KMF: { name: "Comorian Franc",          flag: "🇰🇲", symbol: "Fr" },
  KRW: { name: "South Korean Won",        flag: "🇰🇷", symbol: "₩"  },
  KWD: { name: "Kuwaiti Dinar",           flag: "🇰🇼", symbol: "KD" },
  KYD: { name: "Cayman Islands Dollar",   flag: "🇰🇾", symbol: "$"  },
  KZT: { name: "Kazakhstani Tenge",       flag: "🇰🇿", symbol: "₸"  },
  LAK: { name: "Laotian Kip",             flag: "🇱🇦", symbol: "₭"  },
  LBP: { name: "Lebanese Pound",          flag: "🇱🇧", symbol: "ل.ل"},
  LKR: { name: "Sri Lankan Rupee",        flag: "🇱🇰", symbol: "₨"  },
  LRD: { name: "Liberian Dollar",         flag: "🇱🇷", symbol: "$"  },
  LSL: { name: "Lesotho Loti",            flag: "🇱🇸", symbol: "L"  },
  LYD: { name: "Libyan Dinar",            flag: "🇱🇾", symbol: "ل.د"},
  MAD: { name: "Moroccan Dirham",         flag: "🇲🇦", symbol: "MAD"},
  MDL: { name: "Moldovan Leu",            flag: "🇲🇩", symbol: "L"  },
  MGA: { name: "Malagasy Ariary",         flag: "🇲🇬", symbol: "Ar" },
  MKD: { name: "Macedonian Denar",        flag: "🇲🇰", symbol: "ден"},
  MMK: { name: "Myanmar Kyat",            flag: "🇲🇲", symbol: "K"  },
  MNT: { name: "Mongolian Tugrik",        flag: "🇲🇳", symbol: "₮"  },
  MOP: { name: "Macanese Pataca",         flag: "🇲🇴", symbol: "P"  },
  MRU: { name: "Mauritanian Ouguiya",     flag: "🇲🇷", symbol: "UM" },
  MUR: { name: "Mauritian Rupee",         flag: "🇲🇺", symbol: "₨"  },
  MVR: { name: "Maldivian Rufiyaa",       flag: "🇲🇻", symbol: "Rf" },
  MWK: { name: "Malawian Kwacha",         flag: "🇲🇼", symbol: "MK" },
  MXN: { name: "Mexican Peso",            flag: "🇲🇽", symbol: "$"  },
  MYR: { name: "Malaysian Ringgit",       flag: "🇲🇾", symbol: "RM" },
  MZN: { name: "Mozambican Metical",      flag: "🇲🇿", symbol: "MT" },
  NAD: { name: "Namibian Dollar",         flag: "🇳🇦", symbol: "$"  },
  NGN: { name: "Nigerian Naira",          flag: "🇳🇬", symbol: "₦"  },
  NIO: { name: "Nicaraguan Córdoba",      flag: "🇳🇮", symbol: "C$" },
  NOK: { name: "Norwegian Krone",         flag: "🇳🇴", symbol: "kr" },
  NPR: { name: "Nepalese Rupee",          flag: "🇳🇵", symbol: "₨"  },
  NZD: { name: "New Zealand Dollar",      flag: "🇳🇿", symbol: "$"  },
  OMR: { name: "Omani Rial",              flag: "🇴🇲", symbol: "﷼"  },
  PAB: { name: "Panamanian Balboa",       flag: "🇵🇦", symbol: "B/." },
  PEN: { name: "Peruvian Sol",            flag: "🇵🇪", symbol: "S/" },
  PGK: { name: "Papua New Guinean Kina",  flag: "🇵🇬", symbol: "K"  },
  PHP: { name: "Philippine Peso",         flag: "🇵🇭", symbol: "₱"  },
  PKR: { name: "Pakistani Rupee",         flag: "🇵🇰", symbol: "₨"  },
  PLN: { name: "Polish Zloty",            flag: "🇵🇱", symbol: "zł" },
  PYG: { name: "Paraguayan Guaraní",      flag: "🇵🇾", symbol: "₲"  },
  QAR: { name: "Qatari Riyal",            flag: "🇶🇦", symbol: "﷼"  },
  RON: { name: "Romanian Leu",            flag: "🇷🇴", symbol: "lei"},
  RSD: { name: "Serbian Dinar",           flag: "🇷🇸", symbol: "din"},
  RUB: { name: "Russian Ruble",           flag: "🇷🇺", symbol: "₽"  },
  RWF: { name: "Rwandan Franc",           flag: "🇷🇼", symbol: "Fr" },
  SAR: { name: "Saudi Riyal",             flag: "🇸🇦", symbol: "﷼"  },
  SBD: { name: "Solomon Islands Dollar",  flag: "🇸🇧", symbol: "$"  },
  SCR: { name: "Seychellois Rupee",       flag: "🇸🇨", symbol: "₨"  },
  SDG: { name: "Sudanese Pound",          flag: "🇸🇩", symbol: "ج.س"},
  SEK: { name: "Swedish Krona",           flag: "🇸🇪", symbol: "kr" },
  SGD: { name: "Singapore Dollar",        flag: "🇸🇬", symbol: "$"  },
  SHP: { name: "Saint Helena Pound",      flag: "🇸🇭", symbol: "£"  },
  SLL: { name: "Sierra Leonean Leone",    flag: "🇸🇱", symbol: "Le" },
  SOS: { name: "Somali Shilling",         flag: "🇸🇴", symbol: "Sh" },
  SRD: { name: "Surinamese Dollar",       flag: "🇸🇷", symbol: "$"  },
  STN: { name: "São Tomé & Príncipe Dobra", flag: "🇸🇹", symbol: "Db"},
  SVC: { name: "Salvadoran Colón",        flag: "🇸🇻", symbol: "₡"  },
  SYP: { name: "Syrian Pound",            flag: "🇸🇾", symbol: "£"  },
  SZL: { name: "Swazi Lilangeni",         flag: "🇸🇿", symbol: "L"  },
  THB: { name: "Thai Baht",               flag: "🇹🇭", symbol: "฿"  },
  TJS: { name: "Tajikistani Somoni",      flag: "🇹🇯", symbol: "SM" },
  TMT: { name: "Turkmenistani Manat",     flag: "🇹🇲", symbol: "T"  },
  TND: { name: "Tunisian Dinar",          flag: "🇹🇳", symbol: "DT" },
  TOP: { name: "Tongan Paʻanga",          flag: "🇹🇴", symbol: "T$" },
  TRY: { name: "Turkish Lira",            flag: "🇹🇷", symbol: "₺"  },
  TTD: { name: "Trinidad & Tobago Dollar",flag: "🇹🇹", symbol: "$"  },
  TWD: { name: "New Taiwan Dollar",       flag: "🇹🇼", symbol: "$"  },
  TZS: { name: "Tanzanian Shilling",      flag: "🇹🇿", symbol: "Sh" },
  UAH: { name: "Ukrainian Hryvnia",       flag: "🇺🇦", symbol: "₴"  },
  UGX: { name: "Ugandan Shilling",        flag: "🇺🇬", symbol: "USh"},
  USD: { name: "US Dollar",               flag: "🇺🇸", symbol: "$"  },
  UYU: { name: "Uruguayan Peso",          flag: "🇺🇾", symbol: "$"  },
  UZS: { name: "Uzbekistani Som",         flag: "🇺🇿", symbol: "лв" },
  VES: { name: "Venezuelan Bolívar",      flag: "🇻🇪", symbol: "Bs" },
  VND: { name: "Vietnamese Dong",         flag: "🇻🇳", symbol: "₫"  },
  VUV: { name: "Vanuatu Vatu",            flag: "🇻🇺", symbol: "Vt" },
  WST: { name: "Samoan Tala",             flag: "🇼🇸", symbol: "T"  },
  XAF: { name: "CFA Franc BEAC",         flag: "🌍",  symbol: "Fr" },
  XCD: { name: "East Caribbean Dollar",   flag: "🌎",  symbol: "$"  },
  XOF: { name: "CFA Franc BCEAO",        flag: "🌍",  symbol: "Fr" },
  XPF: { name: "CFP Franc",              flag: "🌏",  symbol: "Fr" },
  YER: { name: "Yemeni Rial",             flag: "🇾🇪", symbol: "﷼"  },
  ZAR: { name: "South African Rand",      flag: "🇿🇦", symbol: "R"  },
  ZMW: { name: "Zambian Kwacha",          flag: "🇿🇲", symbol: "ZK" },
  ZWL: { name: "Zimbabwean Dollar",       flag: "🇿🇼", symbol: "$"  },
};

function getMeta(code: string) {
  return CURRENCY_META[code] ?? { name: code, flag: "🏳", symbol: code };
}

// ── Commodity metadata ─────────────────────────────────────────────────────────

type CommGroup = "precious_metals" | "base_metals" | "energy" | "agricultural";

const COMMODITIES: { key: string; label: string; group: CommGroup; unit: string; flags?: string[] }[] = [
  { key: "gold",        label: "Gold",        group: "precious_metals", unit: "/oz",    flags: ["🇬🇭","🇺🇬"] },
  { key: "silver",      label: "Silver",      group: "precious_metals", unit: "/oz"    },
  { key: "platinum",    label: "Platinum",    group: "precious_metals", unit: "/oz"    },
  { key: "palladium",   label: "Palladium",   group: "precious_metals", unit: "/oz"    },
  { key: "brent_crude", label: "Brent Crude", group: "energy",          unit: "/bbl",  flags: ["🇳🇬","🇺🇬"] },
  { key: "wti_crude",   label: "WTI Crude",   group: "energy",          unit: "/bbl"   },
  { key: "natural_gas", label: "Nat. Gas",    group: "energy",          unit: "/MMBtu" },
  { key: "copper",      label: "Copper",      group: "base_metals",     unit: "/lb",   flags: ["🇲🇼"] },
  { key: "cocoa",       label: "Cocoa",       group: "agricultural",    unit: "/MT",   flags: ["🇬🇭","🇳🇬"] },
  { key: "coffee",      label: "Coffee",      group: "agricultural",    unit: "/lb",   flags: ["🇰🇪","🇺🇬"] },
  { key: "cotton",      label: "Cotton",      group: "agricultural",    unit: "/lb",   flags: ["🇲🇼","🇺🇬"] },
  { key: "sugar",       label: "Sugar",       group: "agricultural",    unit: "/lb",   flags: ["🇲🇼"] },
];

const TICKER_COMMODITY_KEYS = ["gold","brent_crude","cocoa","coffee","copper","natural_gas","silver"];

// ── Types ──────────────────────────────────────────────────────────────────────

type RatesPayload = { rates: Record<string, number>; base: string; updated: string };
type CommPayload  = {
  precious_metals: Record<string, number | null>;
  base_metals:     Record<string, number | null>;
  energy:          Record<string, number | null>;
  agricultural:    Record<string, number | null>;
  updated: string;
};

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtRate(n: number) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 10)   return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function fmtPrice(n: number) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}

function fmtConverted(n: number) {
  if (n >= 1_000_000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1_000)     return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)         return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function xrate(rates: Record<string, number>, amount: number, from: string, to: string) {
  return (amount / (rates[from] ?? 1)) * (rates[to] ?? 1);
}

function commPrice(comm: CommPayload, key: string, group: CommGroup): number | null {
  return comm[group]?.[key] ?? null;
}

// ── Component ──────────────────────────────────────────────────────────────────

type Panel = "currencies" | "commodities" | "convert";

export default function MarketTicker() {
  const [rates,    setRates]   = useState<RatesPayload | null>(null);
  const [comm,     setComm]    = useState<CommPayload  | null>(null);
  const [loading,  setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [paused,   setPaused]  = useState(false);
  const [panel,    setPanel]   = useState<Panel>("currencies");
  const [search,   setSearch]  = useState("");
  const [fromCcy,  setFromCcy] = useState("USD");
  const [toCcy,    setToCcy]   = useState("GHS");
  const [amount,   setAmount]  = useState("1000");
  const [tick,     setTick]    = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [rr, cr] = await Promise.all([fetch("/api/rates"), fetch("/api/commodities")]);
      const rd: RatesPayload = await rr.json();
      const cd: CommPayload  = await cr.json();
      if (!("error" in rd)) setRates(rd);
      if (!("error" in cd)) setComm(cd);
      setTick(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── Build sorted currency list from all API rates ────────────────────────────

  const allCurrencies = useMemo(() => {
    if (!rates?.rates) return [];
    const allCodes   = Object.keys(rates.rates);
    const priority   = PRIORITY_CODES.filter(c => allCodes.includes(c));
    const rest       = allCodes.filter(c => !PRIORITY_CODES.includes(c)).sort();
    return [...priority, ...rest].map(code => ({
      code,
      rate: rates.rates[code],
      ...getMeta(code),
      isPriority: PRIORITY_CODES.includes(code),
      isFocus:    FOCUS_MARKET_CODES.includes(code),
      isGlobal:   MAJOR_GLOBAL_CODES.includes(code),
    }));
  }, [rates]);

  const focusCurrencies  = useMemo(() => allCurrencies.filter(c => c.isFocus),  [allCurrencies]);
  const globalCurrencies = useMemo(() => allCurrencies.filter(c => c.isGlobal), [allCurrencies]);
  const otherCurrencies  = useMemo(() => allCurrencies.filter(c => !c.isPriority), [allCurrencies]);

  // Filtered for search in currencies panel
  const filteredCurrencies = useMemo(() => {
    if (!search.trim()) return allCurrencies;
    const q = search.toLowerCase();
    return allCurrencies.filter(c =>
      c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
    );
  }, [allCurrencies, search]);

  // ── Ticker strip items ───────────────────────────────────────────────────────

  const tickerItems = useMemo(() => [
    ...TICKER_CURRENCY_CODES.map(code => {
      const meta = getMeta(code);
      const rate = rates?.rates[code];
      return { id: code, label: code, flag: meta.flag, value: rate != null ? fmtRate(rate) : "—", sub: "/ USD", isCurrency: true };
    }),
    ...TICKER_COMMODITY_KEYS.map(key => {
      const meta  = COMMODITIES.find(c => c.key === key)!;
      const price = comm ? commPrice(comm, key, meta.group) : null;
      return { id: key, label: meta.label, flag: meta.flags?.[0], value: price != null ? `$${fmtPrice(price)}` : "—", sub: `USD${meta.unit}`, isCurrency: false };
    }),
  ], [rates, comm]);

  // ── Converter ────────────────────────────────────────────────────────────────

  const numAmount  = parseFloat(amount) || 0;
  const converted  = rates?.rates ? xrate(rates.rates, numAmount, fromCcy, toCcy) : 0;
  const toMeta     = getMeta(toCcy);
  const fromMeta   = getMeta(fromCcy);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">

      {/* ── Expanded panel ─────────────────────────────────────────────────── */}
      {expanded && (
        <div className="bg-white border-t border-l border-r border-gray-200 shadow-2xl shadow-black/20 mx-0 sm:mx-4 sm:rounded-t-2xl overflow-hidden">

          {/* Tabs + controls */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-sand border-b border-gray-200 gap-3 flex-wrap">
            <div className="flex gap-1">
              {(["currencies", "commodities", "convert"] as Panel[]).map(p => (
                <button
                  key={p}
                  onClick={() => { setPanel(p); setSearch(""); }}
                  className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                    panel === p ? "bg-navy text-white" : "text-slate-500 hover:text-ink"
                  }`}
                >
                  {p === "currencies" ? `Currencies (${allCurrencies.length || "…"})` : p === "commodities" ? "Commodities" : "Converter"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {tick && <span className="text-xs text-slate-400 hidden sm:block">Updated {tick}</span>}
              <button onClick={fetchAll} className="text-xs text-gold hover:underline hidden sm:block">Refresh</button>
              <Link href="/markets" className="text-xs font-semibold text-gold hover:underline">Full view →</Link>
              <button onClick={() => setExpanded(false)} className="p-1 rounded text-slate-400 hover:text-ink hover:bg-gray-100">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Panel body */}
          <div className="max-h-72 overflow-y-auto">

            {/* ── Currencies ── */}
            {panel === "currencies" && (
              <>
                {/* Search */}
                <div className="px-3 pt-3 pb-2 sticky top-0 bg-white border-b border-gray-100 z-10">
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search currency name or code…"
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/30 bg-sand"
                  />
                </div>

                {search.trim() ? (
                  /* Search results */
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-gray-100">
                    {filteredCurrencies.length === 0 ? (
                      <div className="col-span-full py-8 text-center text-slate-400 text-sm bg-white">No currencies match &ldquo;{search}&rdquo;</div>
                    ) : filteredCurrencies.map(c => (
                      <CurrencyCell key={c.code} code={c.code} name={c.name} flag={c.flag} rate={c.rate} isPriority={c.isPriority} />
                    ))}
                  </div>
                ) : (
                  /* Grouped view */
                  <>
                    {/* Focus markets */}
                    <div className="px-4 pt-3 pb-1">
                      <p className="text-[10px] font-black text-gold tracking-widest uppercase">Focus Markets</p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-px bg-gray-100 mx-0">
                      {focusCurrencies.map(c => (
                        <CurrencyCell key={c.code} code={c.code} name={c.name} flag={c.flag} rate={c.rate} isPriority highlight />
                      ))}
                    </div>

                    {/* Major global */}
                    <div className="px-4 pt-3 pb-1 border-t border-gray-100">
                      <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase">Major Global Currencies</p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-gray-100">
                      {globalCurrencies.map(c => (
                        <CurrencyCell key={c.code} code={c.code} name={c.name} flag={c.flag} rate={c.rate} isPriority />
                      ))}
                    </div>

                    {/* All others */}
                    <div className="px-4 pt-3 pb-1 border-t border-gray-100">
                      <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase">All Currencies</p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-gray-100">
                      {otherCurrencies.map(c => (
                        <CurrencyCell key={c.code} code={c.code} name={c.name} flag={c.flag} rate={c.rate} isPriority={false} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {/* ── Commodities ── */}
            {panel === "commodities" && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-px bg-gray-100">
                {COMMODITIES.map(c => {
                  const price = comm ? commPrice(comm, c.key, c.group) : null;
                  return (
                    <div key={c.key} className="bg-white px-4 py-3 hover:bg-sand/60 transition-colors">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{c.label}</span>
                        {c.flags && <span className="text-xs leading-none">{c.flags.join("")}</span>}
                      </div>
                      <p className="font-mono font-bold text-ink text-sm tabular-nums leading-none">
                        {price != null ? `$${fmtPrice(price)}` : <span className="text-slate-200">—</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-1">USD{c.unit}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Converter ── */}
            {panel === "convert" && (
              <div className="p-5 max-w-lg mx-auto">
                <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
                  <div className="flex gap-2 flex-1">
                    <input
                      type="number"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      className="flex-1 min-w-0 px-3 py-2.5 border border-gray-200 rounded-lg text-ink font-mono text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/30"
                      placeholder="Amount"
                    />
                    <select
                      value={fromCcy}
                      onChange={e => setFromCcy(e.target.value)}
                      className="px-2 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none min-w-[90px]"
                    >
                      <optgroup label="Focus Markets">
                        {focusCurrencies.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                      </optgroup>
                      <optgroup label="Major Currencies">
                        {globalCurrencies.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                      </optgroup>
                      <optgroup label="All Currencies">
                        {otherCurrencies.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                      </optgroup>
                    </select>
                  </div>

                  <button
                    onClick={() => { setFromCcy(toCcy); setToCcy(fromCcy); }}
                    className="self-center w-9 h-9 rounded-full border border-gray-200 bg-white flex items-center justify-center hover:border-gold hover:text-gold transition-colors text-slate-400 shrink-0 mx-auto sm:mx-0"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </button>

                  <div className="flex gap-2 flex-1">
                    <select
                      value={toCcy}
                      onChange={e => setToCcy(e.target.value)}
                      className="flex-1 px-2 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none"
                    >
                      <optgroup label="Focus Markets">
                        {focusCurrencies.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>)}
                      </optgroup>
                      <optgroup label="Major Currencies">
                        {globalCurrencies.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>)}
                      </optgroup>
                      <optgroup label="All Currencies">
                        {otherCurrencies.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>)}
                      </optgroup>
                    </select>
                  </div>
                </div>

                <div className="mt-4 bg-sand border border-gray-200 rounded-xl p-4">
                  {rates?.rates ? (
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div>
                        <p className="text-xs text-slate-400 mb-0.5">
                          {fromMeta.flag} {numAmount.toLocaleString()} {fromCcy} =
                        </p>
                        <p className="text-2xl font-black text-ink tabular-nums">
                          <span className="text-gold">{toMeta.symbol} </span>
                          {fmtConverted(converted)}
                          <span className="text-sm font-medium text-slate-400 ml-1">{toCcy}</span>
                        </p>
                      </div>
                      <div className="text-xs text-slate-400 sm:text-right shrink-0">
                        <p>1 {fromCcy} = {toMeta.symbol}{fmtConverted(xrate(rates.rates, 1, fromCcy, toCcy))} {toCcy}</p>
                        <p className="mt-0.5">1 {toCcy} = {fromMeta.symbol}{fmtConverted(xrate(rates.rates, 1, toCcy, fromCcy))} {fromCcy}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">Loading live rates…</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-gray-100 bg-sand/50 flex items-center justify-between">
            <p className="text-[10px] text-slate-400">
              FX via open.er-api.com · Commodities 15–20 min delayed · Not financial advice
            </p>
          </div>
        </div>
      )}

      {/* ── Ticker bar ─────────────────────────────────────────────────────── */}
      <div className="bg-navy border-t border-white/10 flex items-center h-11 select-none">

        {/* Brand */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="shrink-0 h-full flex items-center gap-2 px-3 border-r border-white/10 hover:bg-white/5 transition-colors"
        >
          <div className="w-5 h-5 rounded bg-gold/20 flex items-center justify-center shrink-0">
            <svg className="w-3 h-3 text-gold" viewBox="0 0 12 12" fill="currentColor">
              <rect x="0" y="7" width="2" height="4" rx="0.5"/>
              <rect x="3" y="5" width="2" height="6" rx="0.5"/>
              <rect x="6" y="3" width="2" height="8" rx="0.5"/>
              <rect x="9" y="1" width="2" height="10" rx="0.5" opacity="0.7"/>
            </svg>
          </div>
          <span className="text-white/50 text-[9px] font-black tracking-widest uppercase hidden sm:block">FCS Markets</span>
        </button>

        {/* Scrolling ticker */}
        <div className="flex-1 overflow-hidden h-full flex items-center">
          {loading ? (
            <div className="flex gap-8 px-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-2.5 bg-white/10 rounded w-16 animate-pulse" />
              ))}
            </div>
          ) : (
            <div
              className="ticker-track"
              style={{ animationPlayState: paused ? "paused" : "running" }}
            >
              {[...tickerItems, ...tickerItems].map((item, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setPanel(item.isCurrency ? "currencies" : "commodities");
                    setSearch("");
                    setExpanded(true);
                  }}
                  className="inline-flex items-center gap-2 px-4 h-11 border-r border-white/5 hover:bg-white/8 transition-colors shrink-0 group"
                >
                  {item.flag && <span className="text-sm leading-none">{item.flag}</span>}
                  <span className="text-white/50 text-[10px] font-semibold tracking-wide group-hover:text-white/80 transition-colors">{item.label}</span>
                  <span className="text-white font-mono text-xs font-bold tabular-nums">{item.value}</span>
                  <span className="text-white/25 text-[9px]">{item.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="shrink-0 flex items-center h-full border-l border-white/10">
          {/* Quick converter shortcut */}
          <button
            onClick={() => { setPanel("convert"); setExpanded(true); }}
            className="h-full px-3 text-gold/60 hover:text-gold hover:bg-white/5 transition-colors hidden sm:flex items-center"
            title="Open converter"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>

          {/* Pause / play */}
          <button
            onClick={() => setPaused(p => !p)}
            className="h-full px-3 text-white/40 hover:text-white hover:bg-white/5 transition-colors flex items-center border-l border-white/10"
            title={paused ? "Resume ticker" : "Pause ticker"}
          >
            {paused ? (
              /* Play icon */
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              /* Pause icon */
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            )}
          </button>

          {/* Expand / collapse */}
          <button
            onClick={() => setExpanded(e => !e)}
            className="h-full px-3 text-white/40 hover:text-white hover:bg-white/5 transition-colors flex items-center border-l border-white/10"
            title={expanded ? "Collapse" : "Expand markets panel"}
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-component for currency cells ──────────────────────────────────────────

function CurrencyCell({
  code, name, flag, rate, isPriority, highlight = false,
}: {
  code: string; name: string; flag: string; rate: number; isPriority: boolean; highlight?: boolean;
}) {
  return (
    <div className={`px-4 py-3 hover:bg-sand/60 transition-colors ${highlight ? "bg-gold/5" : "bg-white"}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-lg leading-none">{flag}</span>
        <span className={`text-[11px] font-bold tracking-wide ${isPriority ? "text-ink" : "text-slate-400"}`}>{code}</span>
      </div>
      <p className="font-mono font-bold text-ink text-sm tabular-nums leading-none">
        {rate != null ? fmtRate(rate) : <span className="text-slate-200">—</span>}
      </p>
      <p className="text-[10px] text-slate-400 mt-0.5 truncate" title={name}>{name}</p>
    </div>
  );
}
