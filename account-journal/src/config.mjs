const DAY_MS = 86_400_000;

function csv(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map((v) => v.trim()).filter(Boolean))];
}

function symbols(value, name) {
  return csv(value).map((value) => {
    const symbol = value.toUpperCase();
    if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error(`${name} contains an invalid symbol`);
    return symbol;
  });
}

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid integer configuration value '${value}'`);
  }
  return parsed;
}

function credentialPair(env, keyName, secretName) {
  const key = env[keyName] || '';
  const secret = env[secretName] || '';
  if (!!key !== !!secret) throw new Error(`${keyName} and ${secretName} must be set together`);
  return key ? { key, secret } : null;
}

function backfillStart(value, nowMs, defaultDays) {
  if (!value) return nowMs - defaultDays * DAY_MS;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > nowMs) {
    throw new Error('JOURNAL_BACKFILL_START must be a valid past ISO timestamp');
  }
  return parsed;
}

export function loadConfig(env = process.env, nowMs = Date.now()) {
  const cloudflare = {
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: env.FCS_D1_DATABASE_ID
  };
  for (const [name, value] of Object.entries(cloudflare)) {
    if (!value) throw new Error(`missing required env var: ${name}`);
  }

  const futuresCredentials = credentialPair(env, 'BINANCE_API_KEY', 'BINANCE_API_SECRET');
  const spotCredentials = credentialPair(env, 'BINANCE_SPOT_API_KEY', 'BINANCE_SPOT_API_SECRET');
  if (!futuresCredentials && !spotCredentials) {
    throw new Error('at least one Binance key/secret pair is required');
  }

  // Reserved by this repository's futures and spot order clients. Operators
  // can replace the list, but the built-in IDs should classify correctly
  // without extra server configuration.
  const botPrefixes = csv(env.JOURNAL_BOT_CLIENT_PREFIXES || 'fcsf-,fcss-');
  const assistedPrefixes = csv(env.JOURNAL_ASSISTED_CLIENT_PREFIXES || 'fcsa-');
  const manualPrefixes = csv(env.JOURNAL_MANUAL_CLIENT_PREFIXES);
  const prefixGroups = [botPrefixes, assistedPrefixes, manualPrefixes];
  for (let i = 0; i < prefixGroups.length; i++) {
    for (let j = i + 1; j < prefixGroups.length; j++) {
      if (prefixGroups[i].some((left) => prefixGroups[j].some((right) => left.startsWith(right) || right.startsWith(left)))) {
        throw new Error('bot, assisted-external, and manual client-order prefixes must not overlap');
      }
    }
  }

  return {
    cloudflare,
    futures: futuresCredentials && {
      ...futuresCredentials,
      market: 'futures',
      base: env.BINANCE_FAPI_BASE || 'https://fapi.binance.com',
      configuredSymbols: symbols(
        env.JOURNAL_FUTURES_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XLMUSDT,XRPUSDT,HYPEUSDT,HBARUSDT,FILUSDT,PEPEUSDT',
        'JOURNAL_FUTURES_SYMBOLS'
      )
    },
    spot: spotCredentials && {
      ...spotCredentials,
      market: 'spot',
      base: env.BINANCE_SPOT_BASE || 'https://api.binance.com',
      quoteAsset: String(env.JOURNAL_SPOT_QUOTE_ASSET || 'USDT').toUpperCase(),
      configuredSymbols: symbols(
        env.JOURNAL_SPOT_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XLMUSDT,XRPUSDT,HYPEUSDT,HBARUSDT,FILUSDT,PEPEUSDT',
        'JOURNAL_SPOT_SYMBOLS'
      )
    },
    botPrefixes,
    assistedPrefixes,
    manualPrefixes,
    backfillStartMs: backfillStart(
      env.JOURNAL_BACKFILL_START,
      nowMs,
      integer(env.JOURNAL_BACKFILL_DAYS, 90, { min: 1, max: 3650 })
    ),
    maxPagesPerSymbol: integer(env.JOURNAL_MAX_PAGES_PER_SYMBOL, 40, { min: 1, max: 500 }),
    tradePageLimit: integer(env.JOURNAL_TRADE_PAGE_LIMIT, 1000, { min: 1, max: 1000 }),
    orderPageLimit: 1000,
    maxOrderPages: integer(env.JOURNAL_MAX_ORDER_PAGES, 20, { min: 1, max: 100 }),
    maxAlgoPollsPerSymbol: integer(env.JOURNAL_MAX_ALGO_POLLS_PER_SYMBOL, 25, { min: 1, max: 250 }),
    requestTimeoutMs: integer(env.JOURNAL_REQUEST_TIMEOUT_MS, 20_000, { min: 1000, max: 60_000 }),
    timeOverlapMs: integer(env.JOURNAL_TIME_OVERLAP_MS, 300_000, { min: 1, max: 3_600_000 }),
    summaryDays: integer(env.JOURNAL_SUMMARY_DAYS, 30, { min: 1, max: 3650 })
  };
}

export const WINDOWS = Object.freeze({ spot: DAY_MS, futures: 7 * DAY_MS });
