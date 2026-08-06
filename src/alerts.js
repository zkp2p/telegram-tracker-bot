const PEERLYTICS_BASE_URL = 'https://peerlytics.xyz';
const PEER_DEPOSITS_URL = 'https://app.peer.xyz/deposits';
const MOBILE_ONBOARD_URL = 'https://mobile.zkp2p.xyz/onboard';

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

function formatFiatValue(value, currencyCode) {
  const code = String(currencyCode || '').trim().toUpperCase();

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

function formatFiatAmount(usdcAmount, conversionRate, currencyCode) {
  const value = (Number(usdcAmount) / 1e6) * (Number(conversionRate) / 1e18);
  return formatFiatValue(value, currencyCode);
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

function formatElapsedTime(startTimestamp, endTimestamp) {
  const elapsedSeconds = Math.max(0, Number(endTimestamp) - Number(startTimestamp));
  const totalMinutes = Math.floor(elapsedSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return '<1m';
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

function createTakeOnWebKeyboard() {
  return {
    inline_keyboard: [[{
      text: 'Take on web',
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
  currencyCode,
  signalTimestamp,
  eventTimestamp
}) {
  const fulfilled = status === 'fulfilled';
  const title = fulfilled ? '🟢 *Order fulfilled*' : '🟠 *Order cancelled*';
  const hasAmounts = amount != null && conversionRate != null && currencyCode;
  const lines = [title, ''];

  if (!hasAmounts) {
    lines.push(`*At:* ${formatAlertTime(eventTimestamp)}`);
    return lines.join('\n');
  }

  lines.push(
    `*Platform:* ${formatPlatform(platform)}`,
    `*From:* ${formatFiatAmount(amount, conversionRate, currencyCode)} ${getCurrencyEmoji(currencyCode)}`,
    `*To:* ${formatUSDCAmount(amount)}`,
    `*At:* ${formatAlertTime(eventTimestamp)}`
  );

  if (fulfilled && signalTimestamp != null && eventTimestamp != null) {
    lines.push(`*Fulfilled in:* ${formatElapsedTime(signalTimestamp, eventTimestamp)}`);
  }

  return lines.join('\n');
}

function buildSniperMessage({
  amount,
  conversionRate,
  marketRate,
  currencyCode,
  isOneToOne,
  timestamp
}) {
  const headline = isOneToOne ? '⚖️ *1:1 opportunity*' : '🎯 *Snipe opportunity*';
  const usdcValue = Number(amount) / 1e6;
  const depositRate = Number(conversionRate) / 1e18;
  const numericMarketRate = Number(marketRate);
  const marketValue = usdcValue * numericMarketRate;
  const profitUsd = numericMarketRate > 0
    ? (marketValue - (usdcValue * depositRate)) / numericMarketRate
    : 0;
  const currencyEmoji = getCurrencyEmoji(currencyCode);

  const lines = [
    headline,
    '',
    `*Pay:* ${formatFiatAmount(amount, conversionRate, currencyCode)} ${currencyEmoji}`,
    `*Receive:* ${formatUSDCAmount(amount)} (= ~${formatFiatValue(marketValue, currencyCode)} ${currencyEmoji})`
  ];

  if (profitUsd > 1) {
    lines.push(`*Profit:* ~${formatFiatValue(profitUsd, 'USD')}`);
  }

  lines.push(
    `*Found:* ${formatAlertTime(timestamp)}`,
    '',
    `[Download the mobile app](${MOBILE_ONBOARD_URL}) to receive faster notifications and snipe on the go.`
  );

  return lines.join('\n');
}

module.exports = {
  MOBILE_ONBOARD_URL,
  PEER_DEPOSITS_URL,
  buildOrderCreatedMessage,
  buildOrderStatusMessage,
  buildSniperMessage,
  createPeerDepositsKeyboard,
  createPeerlyticsKeyboard,
  createTakeOnWebKeyboard,
  formatAlertTime,
  formatElapsedTime,
  formatFiatAmount,
  formatFiatValue,
  formatPlatform,
  formatUSDCAmount,
  getCurrencyEmoji,
  peerlyticsDepositUrl,
  peerlyticsIntentUrl
};
