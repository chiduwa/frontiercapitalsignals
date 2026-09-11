import { positionQuantitiesMatch } from './positions.mjs';

function requiredFiniteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Reconstruct one bot round trip only when the exchange fills prove it. A
// shared one-way symbol can contain operator activity that happened between
// polling cycles; treating every opposite-side fill as the bot's exit would
// silently attribute somebody else's P&L to the model. Ambiguity is an error,
// not a null-filled trade row.
export function summarizeExactRoundTrip(record, fills, entryOrderId) {
  const side = record?.side;
  const expectedQty = Math.abs(Number(record?.entryOriginalQty ?? record?.entryExecutedQty));
  if (!['BUY', 'SELL'].includes(side) || !(expectedQty > 0) || entryOrderId == null) {
    throw new Error('outcome requires a side, positive proven entry quantity, and exact entry order id');
  }
  if (!Array.isArray(fills) || !fills.length) {
    throw new Error('exchange returned no fills for the closed bot position');
  }
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  const normalized = fills.map((fill) => ({
    ...fill,
    orderIdText: String(fill?.orderId ?? ''),
    qtyNumber: Math.abs(requiredFiniteNumber(fill?.qty)),
    priceNumber: requiredFiniteNumber(fill?.price),
    realizedPnlNumber: requiredFiniteNumber(fill?.realizedPnl),
    commissionNumber: requiredFiniteNumber(fill?.commission)
  }));
  if (normalized.some((fill) => !['BUY', 'SELL'].includes(fill.side)
      || !(fill.qtyNumber > 0) || !(fill.priceNumber > 0)
      || fill.realizedPnlNumber == null
      || fill.commissionNumber == null)) {
    throw new Error('exchange returned a non-numeric or malformed fill in the outcome window');
  }
  const exactEntryId = String(entryOrderId);
  const entryFills = normalized.filter((fill) =>
    fill.side === side && fill.orderIdText === exactEntryId);
  const foreignOpeningFills = normalized.filter((fill) =>
    fill.side === side && fill.orderIdText !== exactEntryId);
  if (foreignOpeningFills.length) {
    throw new Error('same-side fills from another order make bot outcome attribution ambiguous');
  }
  const entryQty = entryFills.reduce((total, fill) => total + fill.qtyNumber, 0);
  if (!positionQuantitiesMatch(entryQty, expectedQty)) {
    throw new Error(`exact entry fills total ${entryQty}, expected ${expectedQty}`);
  }
  const closingFills = normalized.filter((fill) => fill.side === closeSide);
  const closingQty = closingFills.reduce((total, fill) => total + fill.qtyNumber, 0);
  if (!positionQuantitiesMatch(closingQty, expectedQty)) {
    throw new Error(`closing fills total ${closingQty}, expected ${expectedQty}`);
  }
  const marginAsset = String(entryFills[0]?.marginAsset || closingFills[0]?.marginAsset || '');
  if (!marginAsset || normalized.some((fill) =>
    String(fill.marginAsset || marginAsset) !== marginAsset
      || String(fill.commissionAsset || marginAsset) !== marginAsset)) {
    throw new Error('outcome costs span missing or different assets and cannot be added without conversion');
  }
  const exitPrice = closingFills.reduce(
    (total, fill) => total + fill.priceNumber * fill.qtyNumber, 0
  ) / closingQty;
  const realizedPnl = normalized.reduce((total, fill) => total + fill.realizedPnlNumber, 0);
  // userTrades reports commission as a positive charge; the outcome ledger
  // stores costs with their economic sign, matching Binance income history.
  const commission = -normalized.reduce((total, fill) => total + fill.commissionNumber, 0);
  return { quantity: closingQty, exitPrice, realizedPnl, commission, marginAsset };
}
