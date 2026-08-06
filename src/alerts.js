const PEERLYTICS_BASE_URL = 'https://peerlytics.xyz';
const PEER_DEPOSITS_URL = 'https://app.peer.xyz/deposits';

const CURRENCY_EMOJIS = Object.freeze({
  AED: '🇦🇪',
  ARS: '🇦🇷',
  AUD: '🇦🇺',
  CAD: '🇨🇦',
  CHF: '🇨🇭',
  CNY: '🇨🇳',
  CZK: '🇨🇿',
  DKK: '🇩🇰',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  HKD: '🇭🇰',
  HUF: '🇭🇺',
  IDR: '🇮🇩',
  ILS: '🇮🇱',
  INR: '🇮🇳',
  JPY: '🇯🇵',
  KES: '🇰🇪',
  MXN: '🇲🇽',
  MYR: '🇲🇾',
  NOK: '🇳🇴',
  NZD: '🇳🇿',
  PHP: '🇵🇭',
  PLN: '🇵🇱',
  RON: '🇷🇴',
  SAR: '🇸🇦',
  SEK: '🇸🇪',
  SGD: '🇸🇬',
  THB: '🇹🇭',
  TRY: '🇹🇷',
  USD: '🇺🇸',
  VND: '🇻🇳',
  ZAR: '🇿🇦'
});

const PLATFORM_LABELS = Object.freeze({
  alipay: 'Alipay',
  cashapp: 'Cash App',
  chime: 'Chime',
  mercadopago: 'Mercado Pago',
  monzo: 'Monzo',
  n26: 'N26',
  paypal: 'PayPal',
  revolut: 'Revolut',
  venmo: 'Venmo',
  wise: 'Wise',
  zelle: 'Zelle'
});

function formatPlatform(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  if (!normalized || normalized.startsWith('unknown')) return 'Payment app';
  return PLATFORM_LABELS[normalized] || normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function getCurrencyEmoji(currencyCode) {
  return CURRENCY_EMOJIS[String(currencyCode || '').trim().toUpperCase()] || '💱';
}

function formatUSDCAmount(amount) {
  const value = Number(amount) / 1e6;
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} USDC`;
}

function formatFiatAmount(usdcAmount, conversionRate, currencyCode) {
  const code = String(currencyCode || '').trim().toUpperCase();
  const value = (Number(usdcAmount) / 1e6) * (Number(conversionRate) / 1e18);

  if (!Number.isFinite(value)) return `Unknown ${code}`.trim();

  try {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
    return `${formatted} ${code}`;
  } catch {
    return `${value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })} ${code}`.trim();
  }
}

function formatAlertTime(timestamp) {
  const date = timestamp instanceof Date
    ? timestamp
    : new Date(Number(timestamp) * 1000);

  if (Number.isNaN(date.getTime())) return 'Unknown time';

  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);

  return `${datePart} at ${timePart} UTC`;
}

function peerlyticsIntentUrl(intentHash) {
  const normalized = String(intentHash || '').trim().toLowerCase();
  return normalized
    ? `${PEERLYTICS_BASE_URL}/explorer/intent/${encodeURIComponent(normalized)}`
    : `${PEERLYTICS_BASE_URL}/explorer`;
}

function peerlyticsDepositUrl(escrowAddress, depositId) {
  const address = String(escrowAddress || '').trim().toLowerCase();
  const id = String(depositId ?? '').trim();
  const routeId = /^0x[0-9a-f]{40}$/.test(address) && /^\d+$/.test(id)
    ? `${address}_${id}`
    : id;

  return routeId
    ? `${PEERLYTICS_BASE_URL}/explorer/deposit/${encodeURIComponent(routeId)}`
    : `${PEERLYTICS_BASE_URL}/explorer`;
}

function createPeerlyticsKeyboard(url) {
  return {
    inline_keyboard: [[{
      text: 'View on Peerlytics',
      url
    }]]
  };
}

function createPeerDepositsKeyboard() {
  return {
    inline_keyboard: [[{
      text: 'View on Peer',
      url: PEER_DEPOSITS_URL
    }]]
  };
}

function buildOrderCreatedMessage({
  platform,
  amount,
  conversionRate,
  currencyCode,
  timestamp
}) {
  return [
    '🟡 *Order created*',
    '',
    `*Platform:* ${formatPlatform(platform)}`,
    `*From:* ${formatFiatAmount(amount, conversionRate, currencyCode)} ${getCurrencyEmoji(currencyCode)}`,
    `*To:* ${formatUSDCAmount(amount)}`,
    `*At:* ${formatAlertTime(timestamp)}`
  ].join('\n');
}

function buildOrderStatusMessage({
  status,
  platform,
  amount,
  conversionRate,
  currencyCode
}) {
  const fulfilled = status === 'fulfilled';
  const title = fulfilled ? '🟢 *Order fulfilled*' : '🟠 *Order cancelled*';
  const verb = fulfilled ? 'fulfilled' : 'cancelled';
  const hasAmounts = amount != null && conversionRate != null && currencyCode;

  if (!hasAmounts) {
    return `${title}\n\nThe order was ${verb}.`;
  }

  return [
    title,
    '',
    `The ${formatPlatform(platform)} order to pay *${formatFiatAmount(amount, conversionRate, currencyCode)}* for *${formatUSDCAmount(amount)}* was ${verb}.`
  ].join('\n');
}

function buildSniperMessage({
  platform,
  amount,
  conversionRate,
  currencyCode,
  percentageDiff,
  isOneToOne,
  timestamp
}) {
  const headline = isOneToOne ? '⚖️ *1:1 opportunity*' : '🎯 *Snipe opportunity*';
  const pricing = isOneToOne
    ? 'at the market rate'
    : `at *${Number(percentageDiff).toFixed(1)}% below market*`;

  return [
    headline,
    '',
    `Pay *${formatFiatAmount(amount, conversionRate, currencyCode)}* with ${formatPlatform(platform)} for *${formatUSDCAmount(amount)}* ${pricing}.`,
    `*Found:* ${formatAlertTime(timestamp)}`
  ].join('\n');
}

module.exports = {
  PEER_DEPOSITS_URL,
  buildOrderCreatedMessage,
  buildOrderStatusMessage,
  buildSniperMessage,
  createPeerDepositsKeyboard,
  createPeerlyticsKeyboard,
  formatAlertTime,
  formatFiatAmount,
  formatPlatform,
  formatUSDCAmount,
  getCurrencyEmoji,
  peerlyticsDepositUrl,
  peerlyticsIntentUrl
};
