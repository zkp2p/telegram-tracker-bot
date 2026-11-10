const DEFAULT_CURATOR_API_URL = 'https://api.zkp2p.xyz';
const REQUEST_TIMEOUT_MS = 5000;

function curatorApiUrl(env) {
  const configured = (env.CURATOR_API_URL ?? '').trim();
  return (configured || DEFAULT_CURATOR_API_URL).replace(/\/+$/, '');
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
  const isPrice = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!isPrice(ask) || !isPrice(bid)) {
    throw new Error('Curator ars-rates is missing the crypto-dollar USDC quote');
  }
  return { ask, bid, midPrice: (ask + bid) / 2 };
}

/**
 * Wraps a rate loader for event bursts: a fresh value is reused for ttlMs,
 * concurrent callers share one request, and a failure is not retried for
 * retryAfterMs. Curator limits market requests per IP, so each log handler
 * fetching on its own would get most of a burst rejected.
 */
function createRateCache({ load, ttlMs, retryAfterMs, onError, now = Date.now }) {
  let value = null;
  let loadedAt = 0;
  let failedAt = -Infinity;
  let inFlight = null;
  return function get() {
    const time = now();
    if (value !== null && time - loadedAt < ttlMs) {
      return Promise.resolve(value);
    }
    if (time - failedAt < retryAfterMs) {
      return Promise.resolve(null);
    }
    inFlight ??= load()
      .then(
        (loaded) => {
          value = loaded;
          loadedAt = now();
          return loaded;
        },
        (error) => {
          failedAt = now();
          onError(error);
          return null;
        }
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

module.exports = { createRateCache, curatorApiUrl, fetchArsUsdcQuote, fetchUsdFxRates };
