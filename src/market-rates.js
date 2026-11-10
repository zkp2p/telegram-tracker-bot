const DEFAULT_CURATOR_API_URL = 'https://api.zkp2p.xyz';
const REQUEST_TIMEOUT_MS = 5000;

function curatorApiUrl(env) {
  return (env.CURATOR_API_URL || DEFAULT_CURATOR_API_URL).trim().replace(/\/+$/, '');
}

async function fetchCuratorMarket(path, { baseUrl, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/v2/market/${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Curator ${path} returned HTTP ${response.status}`);
  }
  const body = await response.json();
  const data = body?.responseObject;
  if (body?.success !== true || typeof data !== 'object' || data === null) {
    throw new Error(`Curator ${path} returned no data`);
  }
  return data;
}

/** Fiat units per USD keyed by currency code, the same table exchangerate-api served. */
async function fetchUsdFxRates(options) {
  const { fiatPerUsd } = await fetchCuratorMarket('fx-rates', options);
  if (typeof fiatPerUsd !== 'object' || fiatPerUsd === null) {
    throw new Error('Curator fx-rates returned no rate table');
  }
  return fiatPerUsd;
}

/**
 * ARS per USDC from CriptoYa's crypto-dollar quote, as the ask/bid mid price.
 * Curator marks a retained last-good snapshot as stale; its age is unknown, so
 * it is rejected instead of being compared against live deposit rates.
 */
async function fetchArsUsdcQuote(options) {
  const { dolar, stale } = await fetchCuratorMarket('ars-rates', options);
  if (stale !== false) {
    throw new Error('Curator ars-rates snapshot is stale');
  }
  const { ask, bid } = dolar?.cripto?.usdc ?? {};
  if (!(ask > 0) || !(bid > 0)) {
    throw new Error('Curator ars-rates is missing the crypto-dollar USDC quote');
  }
  return { ask, bid, midPrice: (ask + bid) / 2 };
}

module.exports = { curatorApiUrl, fetchArsUsdcQuote, fetchUsdFxRates };
