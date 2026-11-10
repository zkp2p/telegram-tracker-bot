function isUrl(value, protocols, allowFragment = true) {
  try {
    const url = new URL(value);
    return /^[a-z]+:\/\//i.test(value.trim()) &&
      protocols.includes(url.protocol) && Boolean(url.hostname) &&
      (allowFragment || !url.hash);
  } catch {
    return false;
  }
}

const checks = {
  // Bot ID + base64url token; do not assume fixed lengths for either part.
  // https://core.telegram.org/bots/api#authorizing-your-bot
  TELEGRAM_BOT_TOKEN: (value) => value === value.trim() && /^[0-9]+:[A-Za-z0-9_-]+$/.test(value),
  SUPABASE_URL: (value) => isUrl(value, ['https:']),
  SUPABASE_ANON_KEY: null,
  // ethers uses ws, which maps http(s) to ws(s) and rejects URL fragments.
  BASE_RPC: (value) => isUrl(value, ['ws:', 'wss:', 'http:', 'https:'], false),
  DISCORD_ORDERS_WEBHOOK_URL: (value) => isUrl(value, ['https:']),
  DISCORD_SNIPER_WEBHOOK_URL: (value) => isUrl(value, ['https:'])
};

const optionalChecks = {
  CURATOR_API_URL: (value) => isUrl(value, ['https:'])
};

function isBlank(value) {
  return value == null || (typeof value === 'string' && !value.trim());
}

function validateConfig(env) {
  const problems = [];
  for (const [key, check] of Object.entries(checks)) {
    const value = env[key];
    if (isBlank(value)) {
      problems.push(`${key}: missing`);
    } else if (typeof value !== 'string' || (check && !check(value))) {
      problems.push(`${key}: invalid`);
    }
  }
  for (const [key, check] of Object.entries(optionalChecks)) {
    const value = env[key];
    if (!isBlank(value) && (typeof value !== 'string' || !check(value))) {
      problems.push(`${key}: invalid`);
    }
  }
  return problems;
}

module.exports = { validateConfig };
