function matchingPrefix(value, prefixes) {
  if (!value) return null;
  return prefixes.find((prefix) => value.startsWith(prefix)) || null;
}

// Classification is intentionally proof-based. Binance trade history does
// not expose a documented UI/API origin, so absence from a bot table is not
// evidence that a person opened the order.
export function classifyOrder({ orderId, clientOrderId }, evidence, config) {
  const override = evidence.overrides.get(String(orderId));
  if (override) {
    return {
      origin: override.origin,
      method: 'explicit_override',
      evidence: override.note || 'operator-set exact order override'
    };
  }

  if (evidence.botOrderIds.has(String(orderId))) {
    return {
      origin: 'bot',
      method: 'bot_ledger_order_id',
      evidence: 'exact exchange order ID recorded by the spot bot'
    };
  }

  // The FCS risk watcher can submit an emergency close for a position it did
  // not open. Keep that P&L outside the bot-strategy cohort: the submitter was
  // code, but the underlying position provenance remains external/unknown.
  const assistedPrefix = matchingPrefix(clientOrderId, config.assistedPrefixes || []);
  if (assistedPrefix) {
    return {
      origin: 'unknown',
      method: 'bot_assisted_external_protection',
      evidence: `reserved assisted-external prefix: ${assistedPrefix}`
    };
  }

  const botPrefix = matchingPrefix(clientOrderId, config.botPrefixes);
  if (botPrefix) {
    return { origin: 'bot', method: 'client_order_prefix', evidence: `reserved bot prefix: ${botPrefix}` };
  }

  const manualPrefix = matchingPrefix(clientOrderId, config.manualPrefixes);
  if (manualPrefix) {
    return { origin: 'manual', method: 'client_order_prefix', evidence: `reserved manual prefix: ${manualPrefix}` };
  }

  // Binance's own forced closes. The exchange submits them with these client
  // order IDs (confirmed for the NEAR and RED liquidations of 2026-10-11/12
  // against the authenticated force-orders endpoint). They say how a position
  // ENDED, not who opened it, so origin stays unknown; the method makes the
  // liquidation visible instead of reading as an unexplained trade.
  if (clientOrderId && clientOrderId.startsWith('adl_autoclose')) {
    return {
      origin: 'unknown',
      method: 'exchange_adl',
      evidence: 'Binance auto-deleverage close (client order ID adl_autoclose…); position owner not established'
    };
  }
  if (clientOrderId && clientOrderId.startsWith('autoclose-')) {
    return {
      origin: 'unknown',
      method: 'exchange_liquidation',
      evidence: 'Binance liquidation-engine close (client order ID autoclose-…); position owner not established'
    };
  }

  return {
    origin: 'unknown',
    method: clientOrderId ? 'no_provenance_match' : 'client_order_id_unavailable',
    evidence: clientOrderId
      ? 'client order ID exists but matches no reserved prefix or exact override'
      : 'no durable client order ID or exact ownership evidence is available'
  };
}
