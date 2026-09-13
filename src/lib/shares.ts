/**
 * Shares outstanding, used to derive market capitalisation as shares x live price.
 *
 * Share counts change only on corporate actions (rights issues, bonus issues,
 * buybacks, redenominations), so they are stored statically and re-verified
 * rather than fetched on every request.
 *
 * GSE figures come from the Ghana Stock Exchange API (dev.kwayisi.org/apis/gse),
 * which publishes an exact count per symbol. Verified September 2026.
 *
 * NGX and MSE are deliberately EMPTY. Neither exchange publishes shares
 * outstanding in a machine-readable form, and the aggregators that carry it
 * round to two significant figures ("21B"), which is not accurate enough to
 * compute a market capitalisation worth showing. Prices for those two markets
 * are live; their market cap renders as "not published" until exact counts are
 * sourced from issuer filings. Adding a ticker here is all that is required --
 * the API and the UI pick it up with no further change.
 */

export const SHARES_OUTSTANDING: Record<string, Record<string, number>> = {
  gse: {
  AADS: 97886800,
  ACCESS: 173947596,
  ADB: 1652681992,
  AGA: 506767346,
  ALLGH: 693147313,
  ALW: 236685180,
  ASG: 902254010,
  BOPP: 34800000,
  CAL: 4232948788,
  CLYD: 34000000,
  CMLT: 6829276,
  CPC: 2038074176,
  DASPHARMA: 84765898,
  DIGICUT: 118890621,
  EGH: 322551209,
  EGL: 170892825,
  ETI: 24067754080,
  FAB: 378231140,
  FML: 116207288,
  GCB: 265000000,
  GGBL: 307594827,
  GLD: 3400000,
  GOIL: 391863128,
  HORDS: 114947561,
  IIL: 375074367,
  KASA: 4133333333,
  MAC: 9948976,
  MMH: 96084166,
  MTNGH: 13236175050,
  PBC: 480000000,
  RBGH: 851966376,
  SAMBA: 5976053,
  SCB: 134758498,
  SCBPREF: 17480000,
  SIC: 195645000,
  SOGEGH: 709141367,
  TBL: 200000000,
  TLW: 1515023041,
  TOTAL: 111874072,
  UNIL: 62500000,
  ZEN: 640000000,
  },

  // Uganda needs no entry: the USE feed publishes market capitalisation directly.
  use: {},

  // See note above before populating these.
  ngx: {},
  mse: {},
};

export function sharesFor(exchangeId: string, ticker: string): number | null {
  return SHARES_OUTSTANDING[exchangeId]?.[ticker] ?? null;
}
