/**
 * Stock exchange reference data for the five FCS focus markets.
 *
 * Structural facts (regulator, depository, settlement cycle, sessions, indices)
 * were verified against each exchange's own site and regulator in September 2026.
 * The listing registers reflect each exchange's official list of traded
 * securities at that date — see DATA_AS_OF below.
 *
 * This is reference data, NOT live quotes. Nothing here carries a price: index
 * levels and market caps move daily and would be stale within a week of any
 * deploy, so each exchange links out to its own live board instead.
 */

export const DATA_AS_OF = "September 2026";

export type ListingStatus = "suspended" | "watchlist" | "restructuring";

export type Listing = {
  ticker: string;
  name: string;
  /** Why this counter matters, for the notable names. */
  note?: string;
  status?: ListingStatus;
};

export type ListingSector = {
  name: string;
  listings: Listing[];
};

export type ExchangeIndex = {
  abbr: string;
  name: string;
  desc: string;
};

export type Venue = {
  label: string;
  url: string;
  desc: string;
};

export type Exchange = {
  id: string;
  country: string;
  /** Anchor id used by the country sections on /resources. */
  countryId: string;
  flag: string;
  name: string;
  abbr: string;
  city: string;
  founded: string;
  currency: string;
  currencyCode: string;
  website: string;
  overview: string;
  regulator: { name: string; url: string };
  depository: { name: string; settlement: string };
  /** The window in which trades can actually be executed — not the pre-open
   *  auction, which several of these exchanges run half an hour earlier. */
  tradingWindow: string;
  /** Full session breakdown, in the exchange's local time. */
  sessions: { label: string; time: string }[];
  timezone: string;
  indices: ExchangeIndex[];
  segments: string[];
  foreignAccess: string;
  /** Other regulated venues in the same market. */
  otherVenues: Venue[];
  sectors: ListingSector[];
};

export const exchanges: Exchange[] = [
  {
    id: "gse",
    country: "Ghana",
    countryId: "ghana",
    flag: "🇬🇭",
    name: "Ghana Stock Exchange",
    abbr: "GSE",
    city: "Accra",
    founded: "Incorporated 1989; trading began November 1990",
    currency: "Ghanaian cedi",
    currencyCode: "GHS",
    website: "https://gse.com.gh",
    overview:
      "The GSE is Ghana's only securities exchange and one of West Africa's two significant equity markets. It is a concentrated market: a handful of counters — MTN Ghana, the Ecobank entities and the large banks — account for most of the capitalisation and nearly all of the turnover, so liquidity outside the top names is thin and position-building takes patience. The exchange also runs the country's fixed income market, which is considerably more liquid than its equity board.",
    regulator: { name: "Securities and Exchange Commission (SEC Ghana)", url: "https://sec.gov.gh" },
    depository: {
      name: "Central Securities Depository (Ghana) Ltd — a Bank of Ghana subsidiary",
      settlement: "T+3 for equities; T+2 on the fixed income market",
    },
    tradingWindow: "10:00 – 15:00",
    sessions: [
      { label: "Continuous trading", time: "10:00 – 15:00" },
      { label: "Fixed income (GFIM)", time: "09:00 – 16:00" },
    ],
    timezone: "GMT",
    indices: [
      { abbr: "GSE-CI", name: "GSE Composite Index", desc: "The benchmark. Market-cap weighted across all listed ordinary shares, excluding companies whose shares are listed on other markets. Base 1,000 at 31 December 2010." },
      { abbr: "GSE-FSI", name: "GSE Financial Stocks Index", desc: "Same construction as the GSE-CI but limited to banking and insurance constituents. Same base and base date." },
    ],
    segments: ["Main market", "Ghana Alternative Market (GAX)", "Ghana Fixed Income Market (GFIM)"],
    foreignAccess:
      "No ceiling on non-resident participation in listed equity, and full remittability of original capital, capital gains and dividends. Acquisitions in banks and insurers need prior Bank of Ghana or National Insurance Commission approval. Trading is through a licensed dealing member.",
    otherVenues: [
      { label: "Ghana Alternative Market (GAX)", url: "https://gse.com.gh", desc: "Lower-threshold board for small and medium enterprises, with lighter listing and reporting requirements than the main market." },
      { label: "Ghana Fixed Income Market (GFIM)", url: "https://gse.com.gh", desc: "Government and corporate debt. Far deeper than the equity board and the main route for institutional cedi exposure." },
      { label: "Ghana Commodity Exchange (GCX)", url: "https://gcx.com.gh", desc: "Spot commodity exchange with warehouse receipts for maize, soya, sorghum, sesame and rice." },
      { label: "Central Securities Depository", url: "https://csd.com.gh", desc: "Depository and settlement for equities and debt; also publishes settlement circulars." },
    ],
    sectors: [
      {
        name: "Banking & Finance",
        listings: [
          { ticker: "ACCESS", name: "Access Bank Ghana" },
          { ticker: "ADB", name: "Agricultural Development Bank" },
          { ticker: "CAL", name: "CalBank Plc" },
          { ticker: "EGH", name: "Ecobank Ghana" },
          { ticker: "ETI", name: "Ecobank Transnational Incorporated", note: "Pan-African banking group; also listed in Lagos and Abidjan." },
          { ticker: "FAB", name: "First Atlantic Bank" },
          { ticker: "GCB", name: "GCB Bank Limited", note: "Largest indigenous Ghanaian bank by branch network." },
          { ticker: "MAC", name: "Mega African Capital" },
          { ticker: "RBGH", name: "Republic Bank Ghana" },
          { ticker: "SCB", name: "Standard Chartered Bank Ghana" },
          { ticker: "SCBPREF", name: "Standard Chartered Preference Shares" },
          { ticker: "SOGEGH", name: "Societe Generale Ghana" },
          { ticker: "TBL", name: "Trust Bank Gambia" },
        ],
      },
      {
        name: "Insurance",
        listings: [
          { ticker: "EGL", name: "Enterprise Group Limited" },
          { ticker: "SIC", name: "SIC Insurance Company" },
        ],
      },
      {
        name: "ICT & Telecoms",
        listings: [
          { ticker: "MTNGH", name: "MTN Ghana", note: "Largest company on the exchange by market capitalisation; Ghana's dominant mobile and mobile-money operator." },
          { ticker: "CLYD", name: "Clydestone Ghana" },
          { ticker: "DIGICUT", name: "Digicut Production & Advertising" },
        ],
      },
      {
        name: "Oil & Gas",
        listings: [
          { ticker: "GOIL", name: "Ghana Oil Company" },
          { ticker: "TOTAL", name: "TotalEnergies Marketing Ghana" },
          { ticker: "TLW", name: "Tullow Oil Plc", note: "Africa-focused oil producer; primary listing in London." },
          { ticker: "ZEN", name: "ZEN Petroleum Holdings" },
        ],
      },
      {
        name: "Mining",
        listings: [
          { ticker: "AGA", name: "AngloGold Ashanti Limited", note: "Gold major; primary listings in New York and Johannesburg." },
          { ticker: "AADS", name: "AngloGold Ashanti Depositary Shares", note: "Ghanaian depositary shares over AngloGold Ashanti stock." },
          { ticker: "ASG", name: "Asante Gold Corp" },
          { ticker: "ALLGH", name: "Atlantic Lithium Ltd" },
        ],
      },
      {
        name: "Agriculture & Agro-processing",
        listings: [
          { ticker: "BOPP", name: "Benso Oil Palm Plantation" },
          { ticker: "CPC", name: "Cocoa Processing Company" },
          { ticker: "PBC", name: "Produce Buying Company" },
          { ticker: "FML", name: "Fan Milk Plc" },
          { ticker: "SAMBA", name: "Samba Foods Limited" },
        ],
      },
      {
        name: "Manufacturing & Consumer",
        listings: [
          { ticker: "GGBL", name: "Guinness Ghana Breweries" },
          { ticker: "UNIL", name: "Unilever Ghana" },
          { ticker: "ALW", name: "Aluworks Limited" },
          { ticker: "CMLT", name: "Camelot Ghana" },
          { ticker: "HORDS", name: "Hords Limited" },
          { ticker: "MMH", name: "Meridian-Marshall Holdings" },
          { ticker: "KASA", name: "Kasapreko Plc", note: "Beverages group; one of the exchange's most recent main-board listings." },
        ],
      },
      {
        name: "Pharmaceuticals",
        listings: [
          { ticker: "DASPHARMA", name: "Dannex Ayrton Starwin Plc" },
          { ticker: "IIL", name: "Intravenous Infusions" },
        ],
      },
      {
        name: "Exchange Traded Funds",
        listings: [
          { ticker: "GLD", name: "NewGold ETF", note: "Physically backed gold ETF; a hard-currency hedge quoted in cedis." },
        ],
      },    ],
  },
  {
    id: "ngx",
    country: "Nigeria",
    countryId: "nigeria",
    flag: "🇳🇬",
    name: "Nigerian Exchange Limited",
    abbr: "NGX",
    city: "Lagos",
    founded: "Founded 1960 as the Lagos Stock Exchange; demutualised March 2021",
    currency: "Nigerian naira",
    currencyCode: "NGN",
    website: "https://ngxgroup.com",
    overview:
      "NGX is the largest equity market in the five, by listings, capitalisation and turnover, and the only one with genuine daily liquidity across more than a handful of counters. Two developments define the current market: the exchange extended its trading day to seven hours in April 2026, and FTSE Russell restored Nigeria to Frontier Market status with effect from 21 September 2026 — nearly three years after removing it — on the strength of improved FX liquidity and capital repatriation. Index-tracking flows follow that reclassification, which is the single most consequential structural change across these five markets this year.",
    regulator: { name: "Securities and Exchange Commission (SEC Nigeria)", url: "https://sec.gov.ng" },
    depository: {
      name: "Central Securities Clearing System Plc (CSCS)",
      settlement: "T+3",
    },
    tradingWindow: "09:00 – 16:00",
    sessions: [
      { label: "Continuous trading", time: "09:00 – 16:00" },
    ],
    timezone: "WAT",
    indices: [
      { abbr: "ASI", name: "NGX All-Share Index", desc: "The benchmark. Value-weighted across all listed equities including the Growth Board, regardless of capitalisation. Formulated January 1984 with a base of 100." },
      { abbr: "NGX 30", name: "NGX 30 Index", desc: "The 30 largest companies by market capitalisation and liquidity, weighted by adjusted market cap with a capping factor." },
      { abbr: "NGX 50", name: "NGX 50 Index", desc: "The same construction extended to 50 constituents." },
      { abbr: "Sector", name: "Sector indices", desc: "Banking, Insurance, Consumer Goods, Industrial Goods, Oil & Gas and Pension series, used as benchmarks by domestic funds." },
    ],
    segments: ["Premium Board", "Main Board", "Growth Board", "ETFs", "REITs", "Fixed income"],
    foreignAccess:
      "Open to foreign portfolio investors, who must obtain a Certificate of Capital Importation through an authorised dealer bank — the CCI is what evidences the inflow and permits later repatriation of capital, dividends and proceeds. Improved FX liquidity and repatriation are precisely what FTSE Russell cited in restoring frontier status.",
    otherVenues: [
      { label: "NASD OTC Securities Exchange", url: "https://nasdng.com", desc: "Regulated over-the-counter market for unlisted public companies — where several large unquoted Nigerian firms actually trade." },
      { label: "FMDQ Securities Exchange", url: "https://fmdqgroup.com", desc: "Fixed income, currencies and derivatives. The primary venue for naira debt and FX price discovery." },
      { label: "AFEX Commodities Exchange", url: "https://afex.africa", desc: "Private commodities exchange with warehousing for maize, paddy rice, soya, sorghum and cocoa." },
      { label: "Lagos Commodities & Futures Exchange", url: "https://lcfe.ng", desc: "SEC-licensed exchange for commodities and futures contracts, including solid minerals and energy." },
      { label: "Central Securities Clearing System", url: "https://cscs.ng", desc: "Depository, clearing and settlement for the Nigerian capital market." },
    ],
    sectors: [
      {
        name: "Financial Services",
        listings: [
          { ticker: "ABBEYBANK", name: "Abbey Bank" },
          { ticker: "ACCESSCORP", name: "Access Holdings Plc" },
          { ticker: "AFRINSURE", name: "African Alliance Insurance" },
          { ticker: "AFRIPRUD", name: "Africa Prudential Plc" },
          { ticker: "AIICO", name: "Aiico Insurance Plc" },
          { ticker: "AVACAP", name: "AVA Capital" },
          { ticker: "CILEASING", name: "C&I Leasing Plc" },
          { ticker: "CONHALLPLC", name: "Consolidated Hallmark Holdings" },
          { ticker: "CORNERST", name: "Cornerstone Insurance Company" },
          { ticker: "CUSTODIAN", name: "Custodian & Allied Plc" },
          { ticker: "ETI", name: "Ecobank Transnational Incorporated", note: "Pan-African banking group; also listed in Accra and Abidjan." },
          { ticker: "FCMB", name: "FCMB Group Plc" },
          { ticker: "FIDELITYBK", name: "Fidelity Bank Plc" },
          { ticker: "FIRSTHOLDCO", name: "First HoldCo Plc" },
          { ticker: "FTGINSURE", name: "Fortis Global Insurance", status: "watchlist", note: "On the NGX delisting watchlist." },
          { ticker: "GTCO", name: "Guaranty Trust Holding", note: "Banking group; formerly dual-listed in London." },
          { ticker: "GUINEAINS", name: "Guinea Insurance" },
          { ticker: "INFINITY", name: "Infinity Trust Mortgage Bank" },
          { ticker: "INTENEGINS", name: "International Energy Insurance" },
          { ticker: "JAIZBANK", name: "Jaiz Bank Plc" },
          { ticker: "LASACO", name: "Lasaco Assurance" },
          { ticker: "LINKASSURE", name: "Linkage Assurance" },
          { ticker: "LIVINGTRUST", name: "LivingTrust Mortgage Bank" },
          { ticker: "MANSARD", name: "AXA Mansard Insurance" },
          { ticker: "MBENEFIT", name: "Mutual Benefits Assurance" },
          { ticker: "NEM", name: "N.E.M. Insurance Company" },
          { ticker: "NGXGROUP", name: "Nigerian Exchange Group", note: "The exchange's own holding company — demutualised and self-listed in 2021." },
          { ticker: "NPFMCRFBK", name: "NPF Microfinance Bank" },
          { ticker: "PRESTIGE", name: "Prestige Assurance Company" },
          { ticker: "REGALINS", name: "Regency Alliance Insurance" },
          { ticker: "ROYALEX", name: "Royal Exchange" },
          { ticker: "SOVRENINS", name: "Sovereign Trust Insurance" },
          { ticker: "STACO", name: "Staco Insurance", status: "watchlist", note: "On the NGX delisting watchlist." },
          { ticker: "STANBIC", name: "Stanbic IBTC Holdings" },
          { ticker: "STERLINGNG", name: "Sterling Bank" },
          { ticker: "SUNUASSUR", name: "Sunu Assurances Nigeria Plc" },
          { ticker: "UBA", name: "United Bank for Africa", note: "Pan-African banking group operating in 20 African countries." },
          { ticker: "UCAP", name: "United Capital Plc" },
          { ticker: "UNITYBNK", name: "Unity Bank" },
          { ticker: "UNIVINSURE", name: "Universal Insurance Company", status: "suspended", note: "Suspended from 20 August 2026 under the Exchange's rules on suspension of trading." },
          { ticker: "VERITASKAP", name: "Veritas Kapital Assurance Plc" },
          { ticker: "VFDGROUP", name: "VFD Group" },
          { ticker: "WAPIC", name: "Coronation Insurance" },
          { ticker: "WEMABANK", name: "Wema Bank" },
          { ticker: "ZENITHBANK", name: "Zenith Bank Plc", note: "One of Nigeria's largest banks by tier-1 capital." },
        ],
      },
      {
        name: "ICT & Telecoms",
        listings: [
          { ticker: "AIRTELAFRI", name: "Airtel Africa Plc", note: "Pan-African telecoms group; primary listing in London." },
          { ticker: "CHAMS", name: "Chams Plc" },
          { ticker: "CWG", name: "Computer Warehouse Group" },
          { ticker: "ETRANZACT", name: "E-Tranzact International" },
          { ticker: "LEGENDINT", name: "Legend Internet" },
          { ticker: "MTNN", name: "MTN Nigeria", note: "Nigeria's largest mobile operator by subscribers." },
          { ticker: "NCR", name: "NCR Nigeria" },
          { ticker: "NSLTECH", name: "Secure Electronic Technology" },
          { ticker: "OMATEK", name: "Omatek Ventures" },
        ],
      },
      {
        name: "Oil & Gas",
        listings: [
          { ticker: "ARADEL", name: "Aradel Holdings", note: "Indigenous oil and gas producer; listed in 2022." },
          { ticker: "CONOIL", name: "Conoil Plc" },
          { ticker: "ETERNA", name: "Eterna Plc" },
          { ticker: "EUNISELL", name: "Eunisell Interlinked Plc" },
          { ticker: "OANDO", name: "Oando Plc" },
          { ticker: "SEPLAT", name: "Seplat Energy Plc", note: "Independent oil and gas producer; dual-listed in London." },
          { ticker: "TIP", name: "The Initiates Plc" },
          { ticker: "TOTAL", name: "TotalEnergies Marketing Nigeria" },
        ],
      },
      {
        name: "Consumer Goods",
        listings: [
          { ticker: "BUAFOODS", name: "BUA Foods" },
          { ticker: "CADBURY", name: "Cadbury Nigeria" },
          { ticker: "CHAMPION", name: "Champion Breweries" },
          { ticker: "DANGSUGAR", name: "Dangote Sugar Refinery" },
          { ticker: "FTNCOCOA", name: "FTN Cocoa Processors", status: "restructuring", note: "On NGX restructuring status, subject to quarterly compliance reports." },
          { ticker: "GOLDBREW", name: "Golden Guinea Breweries", status: "suspended", note: "Suspended since 6 May 2025 for non-submission of financial statements." },
          { ticker: "GUINNESS", name: "Guinness Nigeria" },
          { ticker: "HONYFLOUR", name: "Honeywell Flour Mill" },
          { ticker: "INTBREW", name: "International Breweries" },
          { ticker: "MCNICHOLS", name: "McNichols Plc" },
          { ticker: "MULTITREX", name: "Multi-Trex Integrated Foods", status: "watchlist", note: "On the NGX delisting watchlist." },
          { ticker: "NASCON", name: "National Salt Company" },
          { ticker: "NB", name: "Nigerian Breweries Plc" },
          { ticker: "NESTLE", name: "Nestle Nigeria", note: "Consumer goods multinational subsidiary and a long-standing index heavyweight." },
          { ticker: "NNFM", name: "Northern Nigeria Flour Mills" },
          { ticker: "PZ", name: "PZ Cussons Nigeria" },
          { ticker: "UNILEVER", name: "Unilever Nigeria" },
          { ticker: "VITAFOAM", name: "Vitafoam Nigeria" },
        ],
      },
      {
        name: "Industrial Goods",
        listings: [
          { ticker: "ALEX", name: "Aluminium Extrusion Industries", status: "suspended", note: "Suspended from 22 July 2026 for non-submission of 2025 audited financial statements." },
          { ticker: "AUSTINLAZ", name: "Austin Laz & Company", status: "restructuring", note: "On NGX restructuring status." },
          { ticker: "BERGER", name: "Berger Paints" },
          { ticker: "BETAGLAS", name: "Beta Glass Company" },
          { ticker: "BUACEMENT", name: "BUA Cement Plc", note: "Second-largest cement producer in Nigeria." },
          { ticker: "CAP", name: "CAP Plc" },
          { ticker: "CUTIX", name: "Cutix Plc" },
          { ticker: "DANGCEM", name: "Dangote Cement", note: "Africa's largest cement producer and, with MTN Nigeria, one of the two heaviest weights in the All-Share Index." },
          { ticker: "ENAMELWA", name: "Nigerian Enamelware Plc" },
          { ticker: "MEYER", name: "Meyer Plc" },
          { ticker: "PREMPAINTS", name: "Premier Paints" },
          { ticker: "TRIPPLEG", name: "Tripple Gee & Co. Plc" },
        ],
      },
      {
        name: "Healthcare",
        listings: [
          { ticker: "EKOCORP", name: "Ekocorp Plc", status: "watchlist", note: "Delisting in process, placed on hold pending completion of litigation." },
          { ticker: "FIDSON", name: "Fidson Healthcare" },
          { ticker: "IMG", name: "Industrial & Medical Gases" },
          { ticker: "MAYBAKER", name: "May & Baker Nigeria" },
          { ticker: "MECURE", name: "MeCure Industries" },
          { ticker: "MORISON", name: "Morison Industries" },
          { ticker: "NEIMETH", name: "Neimeth International Pharma" },
          { ticker: "PHARMDEKO", name: "Pharma-Deko Plc" },
        ],
      },
      {
        name: "Agriculture",
        listings: [
          { ticker: "ELLAHLAKES", name: "Ellah Lakes Plc" },
          { ticker: "LIVESTOCK", name: "Livestock Feeds" },
          { ticker: "OKOMUOIL", name: "Okomu Oil Palm", note: "Oil palm producer with plantations in Edo State." },
          { ticker: "PRESCO", name: "Presco Plc", note: "Oil palm producer; one of the best-performing agriculture counters." },
          { ticker: "ZICHIS", name: "Zichis Agro Allied Industries" },
        ],
      },
      {
        name: "Services",
        listings: [
          { ticker: "ABCTRANS", name: "Associated Bus Company" },
          { ticker: "ACADEMY", name: "Academy Press" },
          { ticker: "AFROMEDIA", name: "Afromedia Plc" },
          { ticker: "BAPLC", name: "Briclinks Africa Plc" },
          { ticker: "CAVERTON", name: "Caverton Offshore Support Group" },
          { ticker: "DAARCOMM", name: "Daar Communications" },
          { ticker: "HMCALL", name: "Haldane McCall" },
          { ticker: "IKEJAHOTEL", name: "Ikeja Hotel Plc" },
          { ticker: "JULI", name: "Juli Plc" },
          { ticker: "LEARNAFRCA", name: "Learn Africa" },
          { ticker: "NAHCO", name: "Nigerian Aviation Handling Co." },
          { ticker: "REDSTAREX", name: "Red Star Express Plc" },
          { ticker: "SKYAVN", name: "Skyway Aviation Handling Co. Plc" },
          { ticker: "TANTALIZER", name: "Tantalizers Plc" },
          { ticker: "THOMASWY", name: "Thomas Wyatt Nigeria", status: "restructuring", note: "On NGX restructuring status, subject to quarterly compliance reports." },
          { ticker: "TRANSCOHOT", name: "Transcorp Hotels Plc" },
          { ticker: "TRANSEXPR", name: "Trans-Nationwide Express" },
          { ticker: "UPL", name: "University Press" },
          { ticker: "HBMNG", name: "HBM Nigeria Plc" },
        ],
      },
      {
        name: "Conglomerates",
        listings: [
          { ticker: "CHELLARAM", name: "Chellarams Plc" },
          { ticker: "JOHNHOLT", name: "John Holt Plc" },
          { ticker: "RTBRISCOE", name: "RT Briscoe" },
          { ticker: "SCOA", name: "SCOA Nigeria Plc" },
          { ticker: "TRANSCORP", name: "Transnational Corporation Plc" },
          { ticker: "UACN", name: "UAC of Nigeria" },
          { ticker: "UNIONDICON", name: "Union Dicon Salt", status: "watchlist", note: "On the NGX delisting watchlist." },
        ],
      },
      {
        name: "Natural Resources",
        listings: [
          { ticker: "CMFC", name: "Critical Minerals Financing Corp", status: "watchlist", note: "On the NGX delisting watchlist, subject to filing quarterly compliance reports." },
          { ticker: "JAPAULGOLD", name: "Japaul Gold and Ventures Plc" },
          { ticker: "MULTIVERSE", name: "Multiverse Mining & Exploration" },
          { ticker: "RONCHESS", name: "Ronchess Global Resources" },
        ],
      },
      {
        name: "Utilities",
        listings: [
          { ticker: "GEREGU", name: "Geregu Power Plc", note: "Power generation company; listed in 2022." },
          { ticker: "TRANSPOWER", name: "Transcorp Power", note: "Transcorp Power; listed in 2024 in one of the market's largest listings by value." },
        ],
      },
      {
        name: "Construction & Real Estate",
        listings: [
          { ticker: "JBERGER", name: "Julius Berger Nigeria Plc" },
          { ticker: "UPDC", name: "UPDC Plc" },
        ],
      },
      {
        name: "Funds, REITs & ETFs",
        listings: [
          { ticker: "AVAIF", name: "AVA Infrastructure Fund" },
          { ticker: "CNIF", name: "Coronation Infrastructure Fund" },
          { ticker: "MOFIREIF", name: "MOFI Real Estate Investment Fund" },
          { ticker: "NIDF", name: "Nigeria Infrastructure Debt Fund" },
          { ticker: "NREIT", name: "Nigeria REIT" },
          { ticker: "SFSREIT", name: "Skye Shelter Fund Plc" },
          { ticker: "UHOMREIT", name: "Union Homes Real Estate Inv." },
          { ticker: "UPDCREIT", name: "UPDC Real Estate Investment Trust" },
        ],
      },    ],
  },
  {
    id: "nse",
    country: "Kenya",
    countryId: "kenya",
    flag: "🇰🇪",
    name: "Nairobi Securities Exchange",
    abbr: "NSE",
    city: "Nairobi",
    founded: "Established 1954; demutualised and self-listed 2014",
    currency: "Kenyan shilling",
    currencyCode: "KES",
    website: "https://www.nse.co.ke",
    overview:
      "The NSE is East Africa's principal exchange and the most institutionally developed of the five: it runs the region's only derivatives market outside South Africa, lists three REITs and two ETFs, and operates a platform for unquoted securities. It is also the most foreign-dominated — overseas investors account for a large share of equity turnover, which makes the market sensitive to global risk sentiment and to the shilling. Safaricom alone is a substantial fraction of the index, so NASI often tracks one company more closely than it tracks the Kenyan economy.",
    regulator: { name: "Capital Markets Authority (CMA Kenya)", url: "https://www.cma.or.ke" },
    depository: {
      name: "Central Depository & Settlement Corporation (CDSC)",
      settlement: "T+3",
    },
    tradingWindow: "09:30 – 15:00",
    sessions: [
      { label: "Pre-open", time: "09:00 – 09:30" },
      { label: "Continuous trading", time: "09:30 – 15:00" },
    ],
    timezone: "EAT",
    indices: [
      { abbr: "NASI", name: "NSE All Share Index", desc: "The benchmark. Market-cap weighted across all listed securities, base 100 as at January 2008." },
      { abbr: "NSE 20", name: "NSE 20 Share Index", desc: "The oldest index on the exchange, created in 1966. Price-weighted across 20 actively traded companies." },
      { abbr: "NSE 25", name: "NSE 25 Share Index", desc: "The 25 largest and most liquid companies." },
      { abbr: "FTSE NSE", name: "FTSE NSE Kenya 15 & 25", desc: "Built with FTSE International in 2011 to be investable — designed for index trackers and derivative products." },
    ],
    segments: [
      "Main Investment Market Segment",
      "Growth Enterprise Market Segment (SMEs)",
      "REITs",
      "ETFs",
      "Derivatives (NEXT)",
      "Unquoted Securities Platform",
      "Fixed income",
    ],
    foreignAccess:
      "Kenya removed the 75% ceiling on foreign ownership of listed companies in 2015, so foreign investors may in general hold up to 100%. Issuers must report to the exchange any transaction taking combined foreign and East African holdings to 70% or more. The Foreign Investment Protection Act guarantees repatriation of capital, dividends and interest.",
    otherVenues: [
      { label: "NEXT Derivatives Market", url: "https://www.nse.co.ke/derivatives/", desc: "Single-stock and index futures, launched 2019 — the first derivatives market in sub-Saharan Africa outside South Africa." },
      { label: "Unquoted Securities Platform", url: "https://www.nse.co.ke", desc: "Trading and price discovery for securities of companies that are not listed." },
      { label: "Ibuka", url: "https://www.nse.co.ke", desc: "Incubator and accelerator that prepares private companies for eventual listing." },
      { label: "Central Depository & Settlement Corporation", url: "https://www.cdsckenya.com", desc: "Depository, clearing and settlement; also where an investor's CDS account is held." },
    ],
    sectors: [
      {
        name: "Agricultural",
        listings: [
          { ticker: "EGAD", name: "Eaagads Ltd" },
          { ticker: "KAPC", name: "Kapchorua Tea Kenya Plc" },
          { ticker: "KUKZ", name: "Kakuzi Plc" },
          { ticker: "LIMT", name: "Limuru Tea Co. Plc" },
          { ticker: "SASN", name: "Sasini Plc" },
          { ticker: "WTK", name: "Williamson Tea Kenya Plc" },
        ],
      },
      {
        name: "Automobiles & Accessories",
        listings: [
          { ticker: "CGEN", name: "Car & General (Kenya) Plc" },
        ],
      },
      {
        name: "Banking",
        listings: [
          { ticker: "ABSA", name: "Absa Bank Kenya Plc" },
          { ticker: "SBIC", name: "Stanbic Holdings Plc" },
          { ticker: "IMH", name: "I&M Group Plc" },
          { ticker: "DTK", name: "Diamond Trust Bank Kenya" },
          { ticker: "SCBK", name: "Standard Chartered Bank Kenya" },
          { ticker: "EQTY", name: "Equity Group Holdings", note: "Largest bank in East Africa by customer numbers; subsidiaries across six countries." },
          { ticker: "COOP", name: "Co-operative Bank of Kenya" },
          { ticker: "BKG", name: "BK Group Plc", note: "Rwanda's largest bank; cross-listed from the Rwanda Stock Exchange." },
          { ticker: "FMLY", name: "Family Bank Limited" },
          { ticker: "HFCK", name: "HF Group Plc" },
          { ticker: "KCB", name: "KCB Group Plc", note: "Regional banking group with operations in seven markets." },
          { ticker: "NCBA", name: "NCBA Group Plc" },
        ],
      },
      {
        name: "Commercial & Services",
        listings: [
          { ticker: "XPRS", name: "Express Kenya Plc" },
          { ticker: "SMER", name: "Sameer Africa Plc" },
          { ticker: "KQ", name: "Kenya Airways Plc" },
          { ticker: "NMG", name: "Nation Media Group" },
          { ticker: "SGL", name: "Standard Group Plc" },
          { ticker: "TPSE", name: "TPS Eastern Africa (Serena)" },
          { ticker: "SCAN", name: "Scangroup Plc" },
          { ticker: "UCHM", name: "Uchumi Supermarket" },
          { ticker: "LKL", name: "Longhorn Publishers Plc" },
          { ticker: "DCON", name: "Deacons (East Africa) Plc", status: "suspended", note: "Under administration; trading suspended." },
          { ticker: "NBV", name: "Nairobi Business Ventures" },
        ],
      },
      {
        name: "Construction & Allied",
        listings: [
          { ticker: "ARM", name: "ARM Cement Plc", status: "suspended", note: "Under administration; trading suspended." },
          { ticker: "BAMB", name: "Bamburi Cement Plc", status: "suspended", note: "Suspended from February 2025 following Amsons Group's takeover, pending delisting." },
          { ticker: "CRWN", name: "Crown Paints Kenya Plc" },
          { ticker: "CABL", name: "East African Cables" },
          { ticker: "PORT", name: "East African Portland Cement" },
        ],
      },
      {
        name: "Energy & Petroleum",
        listings: [
          { ticker: "TOTL", name: "TotalEnergies Marketing Kenya" },
          { ticker: "KEGN", name: "KenGen Plc", note: "State-controlled power generator; predominantly geothermal and hydro." },
          { ticker: "KPLC", name: "Kenya Power & Lighting Co." },
          { ticker: "KPLC-P4", name: "Kenya Power 4% Preference Shares" },
          { ticker: "KPLC-P7", name: "Kenya Power 7% Preference Shares" },
          { ticker: "UMME", name: "Umeme Limited" },
          { ticker: "KPC", name: "Kenya Pipeline Company", note: "Kenya Pipeline Company; the exchange's largest IPO in over a decade." },
        ],
      },
      {
        name: "Insurance",
        listings: [
          { ticker: "JUB", name: "Jubilee Holdings" },
          { ticker: "SLAM", name: "Sanlam Allianz Holdings Kenya" },
          { ticker: "KNRE", name: "Kenya Reinsurance Corporation" },
          { ticker: "LBTY", name: "Liberty Kenya Holdings" },
          { ticker: "BRIT", name: "Britam Holdings" },
          { ticker: "CIC", name: "CIC Insurance Group" },
        ],
      },
      {
        name: "Investment",
        listings: [
          { ticker: "OCH", name: "Olympia Capital Holdings" },
          { ticker: "CTUM", name: "Centum Investment Co." },
          { ticker: "TCL", name: "TransCentury Plc" },
          { ticker: "HAFR", name: "Home Afrika Ltd" },
          { ticker: "KURV", name: "Kurwitu Ventures" },
        ],
      },
      {
        name: "Investment Services",
        listings: [
          { ticker: "NSE", name: "Nairobi Securities Exchange Plc", note: "The exchange itself — demutualised and self-listed in 2014." },
        ],
      },
      {
        name: "Manufacturing & Allied",
        listings: [
          { ticker: "BOC", name: "BOC Kenya Plc" },
          { ticker: "BAT", name: "British American Tobacco Kenya", note: "Consistently among the highest dividend yields on the exchange." },
          { ticker: "CARB", name: "Carbacid Investments" },
          { ticker: "EABL", name: "East African Breweries", note: "Diageo-controlled brewer; cross-listed in Kampala and Dar es Salaam." },
          { ticker: "MSC", name: "Mumias Sugar Co.", status: "suspended", note: "Under receivership; trading suspended." },
          { ticker: "UNGA", name: "Unga Group Plc" },
          { ticker: "EVRD", name: "Eveready East Africa" },
          { ticker: "AMAC", name: "Africa Mega Agricorp Plc" },
          { ticker: "FTGH", name: "Flame Tree Group Holdings" },
          { ticker: "SKL", name: "Shri Krishna Overseas" },
        ],
      },
      {
        name: "Telecommunication & Technology",
        listings: [
          { ticker: "SCOM", name: "Safaricom Plc", note: "Largest company on the exchange and the most heavily traded counter; operator of M-Pesa." },
        ],
      },
      {
        name: "Real Estate Investment Trusts",
        listings: [
          { ticker: "LAPR", name: "Laptrust Imara I-REIT" },
          { ticker: "ALP", name: "ALP Industrial REIT" },
          { ticker: "TRFC", name: "TRIFIC Green USD I-REIT" },
        ],
      },
      {
        name: "Exchange Traded Funds",
        listings: [
          { ticker: "GLD", name: "NewGold ETF", note: "Physically backed gold ETF, quoted in shillings." },
          { ticker: "SMWF", name: "Satrix MSCI World Feeder ETF", note: "Feeder fund tracking the MSCI World index — offshore equity exposure from a local account." },
        ],
      },    ],
  },
  {
    id: "mse",
    country: "Malawi",
    countryId: "malawi",
    flag: "🇲🇼",
    name: "Malawi Stock Exchange",
    abbr: "MSE",
    city: "Blantyre",
    founded: "Established 1995; equity trading began November 1996",
    currency: "Malawi kwacha",
    currencyCode: "MWK",
    website: "https://mse.co.mw",
    overview:
      "The smallest and least liquid of the five, with seventeen listed companies and days on which several counters do not trade at all. That is the whole investment case and the whole risk: valuations are set by a shallow domestic buyer base with little foreign participation, entry is cheap by regional standards, and exit can take weeks. Kwacha depreciation has historically eaten a large part of local-currency returns, so the split between the domestic and foreign share indices matters more here than the headline index does.",
    regulator: { name: "Reserve Bank of Malawi (Registrar of Financial Institutions)", url: "https://www.rbm.mw" },
    depository: {
      name: "Central Securities Depository account held at the Reserve Bank of Malawi",
      settlement: "T+3",
    },
    tradingWindow: "09:30 – 14:30",
    sessions: [
      { label: "Pre-open", time: "09:00 – 09:30" },
      { label: "Open", time: "09:30 – 14:30" },
      { label: "Close", time: "14:30 – 15:00" },
      { label: "Post-close", time: "15:00 – 17:00" },
    ],
    timezone: "CAT",
    indices: [
      { abbr: "MASI", name: "Malawi All Share Index", desc: "The benchmark — average price movement across all counters." },
      { abbr: "DSI", name: "Domestic Share Index", desc: "Locally registered companies only. The better read on the Malawian economy." },
      { abbr: "FSI", name: "Foreign Share Index", desc: "Foreign-owned counters, currently dominated by Old Mutual's dual listing." },
    ],
    segments: ["Main Board", "Alternative Capital Market", "Debt Market"],
    foreignAccess:
      "Open to foreign investors through a licensed stockbroker and a CSD account. The binding constraints in practice are not ownership rules but FX: kwacha liquidity for converting proceeds has been episodically tight, and that, rather than the listing rules, is what determines how quickly capital can leave.",
    otherVenues: [
      { label: "Alternative Capital Market", url: "https://mse.co.mw", desc: "Lower-cost board for small and medium enterprises raising capital." },
      { label: "MSE Debt Market", url: "https://mse.co.mw", desc: "Government and corporate notes; the listed board carries a substantial number of Treasury notes." },
      { label: "Reserve Bank of Malawi", url: "https://www.rbm.mw", desc: "Securities market regulator, and host of the central securities depository." },
    ],
    sectors: [
      {
        name: "Banking & Financial Services",
        listings: [
          { ticker: "FDHB", name: "FDH Bank Plc" },
          { ticker: "FMBCH", name: "FMB Capital Holdings Plc", note: "Regional banking group operating across five Southern African markets." },
          { ticker: "NBM", name: "National Bank of Malawi", note: "Malawi's largest bank by assets and the exchange's heaviest-weighted counter." },
          { ticker: "NBS", name: "NBS Bank Plc" },
          { ticker: "STANDARD", name: "Standard Bank Malawi Plc" },
          { ticker: "NICO", name: "NICO Holdings Plc" },
          { ticker: "NITL", name: "National Investment Trust Plc" },
          { ticker: "OMU", name: "Old Mutual Limited", note: "Pan-African financial services group; primary listing in Johannesburg." },
        ],
      },
      {
        name: "Telecommunications",
        listings: [
          { ticker: "AIRTEL", name: "Airtel Malawi Plc", note: "Mobile and mobile-money operator; listed in 2020 in Malawi's largest IPO." },
          { ticker: "TNM", name: "Telekom Networks Malawi Plc" },
        ],
      },
      {
        name: "Property & Hospitality",
        listings: [
          { ticker: "BHL", name: "Blantyre Hotels Plc" },
          { ticker: "ICON", name: "Icon Properties Plc" },
          { ticker: "MPICO", name: "Malawi Property Investment Co." },
          { ticker: "SUNBIRD", name: "Sunbird Tourism Plc" },
        ],
      },
      {
        name: "Agriculture & Manufacturing",
        listings: [
          { ticker: "ILLOVO", name: "Illovo Sugar Malawi Plc", note: "Malawi's dominant sugar producer and a major exporter." },
        ],
      },
      {
        name: "Conglomerates",
        listings: [
          { ticker: "PCL", name: "Press Corporation Plc", note: "Diversified conglomerate with interests in telecoms, banking, energy and consumer goods." },
          { ticker: "CHL", name: "Continental Holdings Plc", note: "Listed on the main board in August 2026 as the exchange's 17th company." },
        ],
      },    ],
  },
  {
    id: "use",
    country: "Uganda",
    countryId: "uganda",
    flag: "🇺🇬",
    name: "Uganda Securities Exchange",
    abbr: "USE",
    city: "Kampala",
    founded: "Incorporated 1997; trading began 1998",
    currency: "Ugandan shilling",
    currencyCode: "UGX",
    website: "https://www.use.or.ug",
    overview:
      "A small exchange with an unusual composition: eight of its nineteen counters are cross-listings of Nairobi-quoted companies, so a Ugandan portfolio bought on the USE is partly a Kenyan portfolio. The local board is dominated by the two telecoms — MTN Uganda and Airtel Uganda both came to market under licence obligations rather than a need for capital, which is why Uganda's largest listings arrived within two years of each other. Trading is a single short session, and depth outside the telecoms and Stanbic is limited.",
    regulator: { name: "Capital Markets Authority (CMA Uganda)", url: "https://cmauganda.co.ug" },
    depository: {
      name: "USE Securities Central Depository (SCD)",
      settlement: "T+3, with delivery versus payment and a settlement guarantee fund",
    },
    tradingWindow: "09:00 – 13:00",
    sessions: [{ label: "Trading", time: "09:00 – 13:00" }],
    timezone: "EAT",
    indices: [
      { abbr: "ALSI", name: "USE All Share Index", desc: "The benchmark. Market-weighted across all listed stocks, launched October 2003 and backdated to a base of 100 at 31 December 2000." },
      { abbr: "LCI", name: "USE Local Company Index", desc: "Domestically incorporated companies only — it strips out the Nairobi cross-listings, which is what you want when reading Uganda specifically." },
    ],
    segments: ["Main Investment Market Segment", "Growth Enterprise Market Segment", "Fixed income"],
    foreignAccess:
      "No ownership ceiling for foreign investors in listed companies. Trading is through a licensed broker with an SCD account. Uganda's capital account is comparatively open and the shilling is convertible, which makes repatriation more straightforward here than in several neighbouring frontier markets.",
    otherVenues: [
      { label: "ALTX East Africa", url: "https://altxafrica.com", desc: "A separately licensed Ugandan exchange focused on fixed income and alternative asset listings." },
      { label: "USE Securities Central Depository", url: "https://use.or.ug/scd/services/clearing-and-settlement", desc: "Clearing, settlement and depository, operated by the exchange itself." },
      { label: "Capital Markets Authority Uganda", url: "https://cmauganda.co.ug", desc: "Licenses brokers and approves issues; publishes the list of licensed market intermediaries." },
    ],
    sectors: [
      {
        name: "Local listings",
        listings: [
          { ticker: "AIRTEL", name: "Airtel Uganda Ltd", note: "Listed in 2023 under the same licence obligation that brought MTN Uganda to market." },
          { ticker: "BATU", name: "British American Tobacco Uganda", note: "Tobacco processor and one of the exchange's longest-standing listings." },
          { ticker: "BOBU", name: "Bank of Baroda Uganda" },
          { ticker: "DFCU", name: "DFCU Limited" },
          { ticker: "MTNU", name: "MTN Uganda Ltd", note: "Largest company on the exchange; listed in 2021 in Uganda's biggest IPO." },
          { ticker: "NIC", name: "National Insurance Corporation" },
          { ticker: "NVL", name: "New Vision Printing & Publishing" },
          { ticker: "QCIL", name: "Cipla Quality Chemical Industries", note: "Antiretroviral and antimalarial manufacturer; the only pharmaceutical producer listed in the region." },
          { ticker: "SBU", name: "Stanbic Uganda Holdings", note: "Uganda's largest bank by assets." },
          { ticker: "UCL", name: "Uganda Clays Ltd" },
          { ticker: "UMEM", name: "Umeme Limited", note: "Electricity distributor whose 20-year concession ended in March 2025." },
        ],
      },
      {
        name: "Cross-listed from Nairobi",
        listings: [
          { ticker: "CENT", name: "Centum Investment Co." },
          { ticker: "EABL", name: "East African Breweries" },
          { ticker: "EBL", name: "Equity Group Holdings" },
          { ticker: "JHL", name: "Jubilee Holdings" },
          { ticker: "KA", name: "Kenya Airways Plc" },
          { ticker: "KCB", name: "KCB Group Plc" },
          { ticker: "NMG", name: "Nation Media Group" },
          { ticker: "UCHM", name: "Uchumi Supermarket" },
        ],
      },    ],
  },
];

/** Total count of securities on an exchange's register. */
export function listingCount(exchange: Exchange): number {
  return exchange.sectors.reduce((n, s) => n + s.listings.length, 0);
}

export function getExchange(id: string): Exchange | undefined {
  return exchanges.find((e) => e.id === id);
}

/** Every listing across all five exchanges, flattened for search. */
export function allListings() {
  return exchanges.flatMap((e) =>
    e.sectors.flatMap((s) =>
      s.listings.map((l) => ({ ...l, sector: s.name, exchange: e }))
    )
  );
}
