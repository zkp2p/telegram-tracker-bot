const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AbiCoder, Interface, toBeHex, zeroPadValue } = require('ethers');
const { TelegramBot } = require('node-telegram-bot-api');
const {
  ACTIVE_PAYMENT_METHODS,
  CONTRACT_ADDRESSES,
  HISTORICAL_PAYMENT_METHODS,
  SUPPORTED_SNIPER_PLATFORMS,
  escrowAbi,
  escrowV2Abi,
  getPlatformName,
  isQuotedConversionRate,
  legacyEscrowAbi,
  modernOrchestratorAbi,
  orchestratorAbi,
  orchestratorV4Abi
} = require('./src/contracts');
const { createAddressRouter } = require('./src/resilient-websocket-provider');
const { createTelegramNotifier } = require('./src/telegram');
const {
  buildBuyOrderCreatedMessage,
  buildBuyOrderStatusMessage,
  buildSellOrderCreatedMessage,
  buildSniperMessage,
  createPeerExplorerBuyKeyboard,
  createPeerExplorerSellKeyboard,
  createTakeOnWebKeyboard,
  formatElapsedTime,
  formatPlatform,
  peerExplorerBuyUrl
} = require('./src/alerts');
const { resolveBlockTimestamp, toHttpRpcUrl } = require('./src/chain');
const { createRateCache, curatorApiUrl, fetchArsUsdcQuote, fetchUsdFxRates } = require('./src/market-rates');
const { createDepositCreationCollector } = require('./src/deposit-creations');
const {
  OFFICIAL_GROUP_CHAT_ID,
  includeOfficialGroup,
  isOfficialGroup
} = require('./src/recipients');

const coder = AbiCoder.defaultAbiCoder();

describe('Startup configuration', () => {
  const validEnv = Object.freeze({
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'supabase-key-marker',
    BASE_RPC: 'wss://rpc.example.test/v2/rpc-key-marker',
    DISCORD_ORDERS_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/orders-marker',
    DISCORD_SNIPER_WEBHOOK_URL: 'https://discord.com/api/webhooks/456/sniper-marker'
  });

  it('accepts valid configuration without mutating it; NODE_ENV is optional', () => {
    const { validateConfig } = require('./src/config');
    assert.deepEqual(validateConfig(validEnv), []);
    assert.deepEqual(validateConfig({ ...validEnv, NODE_ENV: 'production' }), []);
  });

  for (const key of Object.keys(validEnv)) {
    it(`reports missing or blank ${key}`, () => {
      const { validateConfig } = require('./src/config');
      const env = { ...validEnv };
      delete env[key];
      assert.deepEqual(validateConfig(env), [`${key}: missing`]);
      for (const value of ['', ' \t\r\n ']) {
        assert.deepEqual(validateConfig({ ...validEnv, [key]: value }), [`${key}: missing`]);
      }
    });
  }

  for (const key of ['SUPABASE_URL', 'BASE_RPC', 'DISCORD_ORDERS_WEBHOOK_URL', 'DISCORD_SNIPER_WEBHOOK_URL']) {
    it(`rejects malformed URLs and unsupported schemes for ${key}`, () => {
      const { validateConfig } = require('./src/config');
      for (const value of ['url-marker', '/relative-marker', 'https://', 'https:host-marker',
        'https://bad host-marker', 'https://host-marker:99999', 'ftp://host-marker']) {
        assert.deepEqual(validateConfig({ ...validEnv, [key]: value }), [`${key}: invalid`]);
      }
      if (key !== 'BASE_RPC') {
        for (const scheme of ['http', 'ws', 'wss']) {
          assert.deepEqual(validateConfig({ ...validEnv, [key]: `${scheme}://host-marker` }), [`${key}: invalid`]);
        }
      }
    });
  }

  it('accepts all WebSocket-supported RPC schemes and rejects fragments', () => {
    const { validateConfig } = require('./src/config');
    for (const scheme of ['ws', 'wss', 'http', 'https']) {
      const BASE_RPC = `${scheme}://rpc.example.test/v2/key-marker?apiKey=query-marker`;
      assert.deepEqual(validateConfig({ ...validEnv, BASE_RPC }), []);
      assert.deepEqual(validateConfig({ ...validEnv, BASE_RPC: `${BASE_RPC}#fragment-marker` }), ['BASE_RPC: invalid']);
    }
  });

  it('checks Telegram token characters without assuming fixed lengths', () => {
    const { validateConfig } = require('./src/config');
    for (const TELEGRAM_BOT_TOKEN of ['1:a_B-9', '1234567890123:AbCdEf_0123456789-']) {
      assert.deepEqual(validateConfig({ ...validEnv, TELEGRAM_BOT_TOKEN }), []);
    }
    for (const TELEGRAM_BOT_TOKEN of ['token-marker', 'abc:token-marker', '123:', ':token-marker',
      '123:token marker', '123:token/marker', '123:token:marker', '123:token-marker\n', ' 123:token-marker']) {
      assert.deepEqual(validateConfig({ ...validEnv, TELEGRAM_BOT_TOKEN }), ['TELEGRAM_BOT_TOKEN: invalid']);
    }
  });

  it('reports every problem using only keys and reasons', () => {
    const { validateConfig } = require('./src/config');
    const env = { ...validEnv, TELEGRAM_BOT_TOKEN: 'short!', SUPABASE_URL: 'https://secret-marker:bad-port' };
    delete env.SUPABASE_ANON_KEY;
    const problems = validateConfig(env);
    assert.deepEqual(problems, ['TELEGRAM_BOT_TOKEN: invalid', 'SUPABASE_URL: invalid', 'SUPABASE_ANON_KEY: missing']);
    for (const value of Object.values(env)) assert.equal(problems.join('; ').includes(value), false);
    assert.equal(problems.join('; ').includes('secret-marker'), false);
  });

  it('treats the Curator URL as optional and requires HTTPS when it is set', () => {
    const { validateConfig } = require('./src/config');
    for (const CURATOR_API_URL of [undefined, '', ' \t ', 'https://curator.example.test', 'https://curator.example.test/']) {
      assert.deepEqual(validateConfig({ ...validEnv, CURATOR_API_URL }), []);
    }
    for (const CURATOR_API_URL of ['curator-marker', 'http://curator-marker', 'wss://curator-marker', 'https://']) {
      assert.deepEqual(validateConfig({ ...validEnv, CURATOR_API_URL }), ['CURATOR_API_URL: invalid']);
    }
  });

  it('starts without an exchange-rate API key', () => {
    const { validateConfig } = require('./src/config');
    assert.equal('EXCHANGE_API_KEY' in validEnv, false);
    assert.deepEqual(validateConfig(validEnv), []);
  });

  it('exits 1 with one safe stderr line before loading client dependencies', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tracker-config-test-'));
    // Block clients so a regression cannot contact upstreams or start polling.
    const script = `
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function (id, ...args) {
        if (['ethers', '@supabase/supabase-js', 'node-telegram-bot-api',
          './src/resilient-websocket-provider'].includes(id)) {
          throw new Error('Client dependency loaded before configuration validation');
        }
        return load.call(this, id, ...args);
      };
      require(${JSON.stringify(require.resolve('./bot'))});
    `;
    try {
      const invalidEnv = { ...validEnv,
        TELEGRAM_BOT_TOKEN: 'short!',
        SUPABASE_URL: 'https://supabase-marker:bad-port',
        BASE_RPC: 'wss://rpc.example.test/#rpc-marker',
        DISCORD_ORDERS_WEBHOOK_URL: 'http://orders-marker',
        DISCORD_SNIPER_WEBHOOK_URL: 'sniper-marker'
      };
      const invalidCuratorEnv = { ...validEnv, CURATOR_API_URL: 'http://curator-marker' };
      for (const [env, problems] of [
        [{}, Object.keys(validEnv).map((key) => `${key}: missing`)],
        [invalidCuratorEnv, ['CURATOR_API_URL: invalid']],
        [invalidEnv, ['TELEGRAM_BOT_TOKEN: invalid', 'SUPABASE_URL: invalid', 'BASE_RPC: invalid',
          'DISCORD_ORDERS_WEBHOOK_URL: invalid', 'DISCORD_SNIPER_WEBHOOK_URL: invalid']]
      ]) {
        const result = spawnSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8', timeout: 5000 });
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `Invalid configuration: ${problems.join('; ')}\n`);
        assert.equal(result.stderr.includes('marker'), false);
        assert.equal(result.stderr.includes('short!'), false);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Runtime dependencies', () => {
  it('exposes the Telegram client constructor used by the bot', () => {
    const client = new TelegramBot('test-token', { polling: false });
    assert.equal(typeof client.getMe, 'function');
    assert.equal(typeof client.onText, 'function');
    assert.equal(typeof client.sendMessage, 'function');
    assert.equal(typeof client.stopPolling, 'function');
  });

  it('isolates Telegram recipient failures', async () => {
    const errors = [];
    const notify = createTelegramNotifier(
      { sendMessage: async () => { throw new Error('400 chat not found'); } },
      { error: (...args) => errors.push(args) }
    );

    assert.equal(await notify(123, 'hello', {}, 'test alert'), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /test alert.*123/);
  });

  it('reports successful Telegram deliveries', async () => {
    const notify = createTelegramNotifier({ sendMessage: async () => ({ message_id: 1 }) });
    assert.equal(await notify(123, 'hello', {}, 'test alert'), true);
  });
});

describe('Official group recipients', () => {
  it('keeps the official Peer trade feed subscribed', () => {
    assert.deepEqual(includeOfficialGroup([]), [OFFICIAL_GROUP_CHAT_ID]);
    assert.deepEqual(
      includeOfficialGroup([123, OFFICIAL_GROUP_CHAT_ID, 123]),
      [123, OFFICIAL_GROUP_CHAT_ID]
    );
  });

  it('only protects the official group from disabling the feed', () => {
    assert.equal(isOfficialGroup(OFFICIAL_GROUP_CHAT_ID), true);
    assert.equal(isOfficialGroup(123), false);
  });
});

describe('Block timestamp resolution', () => {
  it('uses the terminal event block timestamp', async () => {
    const provider = { getBlock: async (blockNumber) => ({ number: blockNumber, timestamp: 123456 }) };
    assert.equal(await resolveBlockTimestamp(provider, 99), 123456);
  });

  it('falls back without dropping alerts when the RPC lookup fails', async () => {
    const warnings = [];
    const provider = { getBlock: async () => { throw new Error('RPC unavailable'); } };
    const timestamp = await resolveBlockTimestamp(provider, 99, {
      fallbackTimestamp: 654321,
      logger: { warn: (...args) => warnings.push(args) }
    });

    assert.equal(timestamp, 654321);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /block 99/);
  });
});

describe('RPC endpoint', () => {
  it('derives the HTTP endpoint from the configured WebSocket endpoint', () => {
    assert.equal(toHttpRpcUrl('wss://rpc.example.test/v2/key?x=1'), 'https://rpc.example.test/v2/key?x=1');
    assert.equal(toHttpRpcUrl('ws://127.0.0.1:8546/path'), 'http://127.0.0.1:8546/path');
    assert.equal(toHttpRpcUrl(' WSS://rpc.example.test/v2/key '), 'https://rpc.example.test/v2/key');
  });

  it('keeps an HTTP endpoint unchanged', () => {
    for (const url of ['https://rpc.example.test/v2/key', 'http://127.0.0.1:8545']) {
      assert.equal(toHttpRpcUrl(url), url);
    }
  });

  it('never falls back to a public RPC in the bot', () => {
    const { readFileSync } = require('node:fs');
    const source = readFileSync(require.resolve('./bot'), 'utf8');
    assert.equal(/mainnet\.base\.org|exchangerate-api|criptoya\.com/.test(source), false);
    assert.equal(source.includes('new JsonRpcProvider(toHttpRpcUrl(process.env.BASE_RPC))'), true);
  });
});

describe('Market rates from Curator', () => {
  const baseUrl = 'https://curator.example.test';
  const reply = (body, { ok = true, status = 200 } = {}) => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      return { ok, status, json: async () => body };
    };
    return { fetchImpl, requests };
  };
  const arsBody = (usdc, stale = false) => ({
    success: true,
    responseObject: {
      observedAt: 1794345388,
      usdcArs: { ripio: { ask: 1, bid: 2 } },
      usdtArs: { ripio: { ask: 3, bid: 4 } },
      dolar: { blue: { ask: 5, bid: 6 }, cripto: { usdt: { ask: 7, bid: 8 }, usdc } },
      fromCache: true,
      stale
    }
  });

  it('defaults to the production Curator and strips trailing slashes', () => {
    assert.equal(curatorApiUrl({}), 'https://api.zkp2p.xyz');
    assert.equal(curatorApiUrl({ CURATOR_API_URL: '' }), 'https://api.zkp2p.xyz');
    assert.equal(curatorApiUrl({ CURATOR_API_URL: ' \t ' }), 'https://api.zkp2p.xyz');
    assert.equal(curatorApiUrl({ CURATOR_API_URL: ' https://curator.example.test// ' }), baseUrl);
  });

  it('reads the USD rate table from fx-rates with a request timeout', async () => {
    const fiatPerUsd = { USD: 1, EUR: 0.9, INR: 83.25 };
    const { fetchImpl, requests } = reply({ success: true, responseObject: { observedAt: 1, fiatPerUsd, fromCache: true } });
    assert.deepEqual(await fetchUsdFxRates({ baseUrl, fetchImpl }), fiatPerUsd);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://curator.example.test/v2/market/fx-rates');
    assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  });

  it('rejects failed, unsuccessful and malformed fx-rates replies', async () => {
    for (const { fetchImpl } of [
      reply({ success: true, responseObject: { fiatPerUsd: {} } }, { ok: false, status: 502 }),
      reply({ success: false, responseObject: null }),
      reply({ success: true, responseObject: { observedAt: 1 } }),
      reply(null)
    ]) {
      await assert.rejects(fetchUsdFxRates({ baseUrl, fetchImpl }));
    }
  });

  it('uses the crypto-dollar USDC mid price from ars-rates', async () => {
    const { fetchImpl, requests } = reply(arsBody({ ask: 1643.035, bid: 1690.503 }));
    assert.deepEqual(await fetchArsUsdcQuote({ baseUrl, fetchImpl }), {
      ask: 1643.035,
      bid: 1690.503,
      midPrice: (1643.035 + 1690.503) / 2
    });
    assert.equal(requests[0].url, 'https://curator.example.test/v2/market/ars-rates');
  });

  it('rejects a stale ars-rates snapshot instead of using an old price', async () => {
    const { fetchImpl } = reply(arsBody({ ask: 1643.035, bid: 1690.503 }, true));
    await assert.rejects(fetchArsUsdcQuote({ baseUrl, fetchImpl }), /stale/);
  });

  it('rejects ars-rates replies without a usable USDC quote', async () => {
    for (const usdc of [undefined, {}, { ask: 1643.035 }, { ask: 0, bid: 1690.503 }, { ask: '1643', bid: null },
      { ask: '1643.035', bid: '1690.503' }, { ask: 1643.035, bid: Infinity }]) {
      const { fetchImpl } = reply(arsBody(usdc));
      await assert.rejects(fetchArsUsdcQuote({ baseUrl, fetchImpl }));
    }
    const { fetchImpl } = reply({ success: true, responseObject: { stale: false } });
    await assert.rejects(fetchArsUsdcQuote({ baseUrl, fetchImpl }));
  });
});

describe('Market rate cache', () => {
  const setup = ({ results, ttlMs = 60000, retryAfterMs = 5000 }) => {
    const state = { time: 1000, loads: 0, errors: [] };
    const pending = [];
    const get = createRateCache({
      ttlMs,
      retryAfterMs,
      now: () => state.time,
      onError: (error) => state.errors.push(error.message),
      load: () => {
        const result = results[state.loads];
        state.loads += 1;
        return new Promise((resolve, reject) => {
          pending.push(() => (result instanceof Error ? reject(result) : resolve(result)));
        });
      }
    });
    const settle = () => pending.shift()();
    return { get, settle, state };
  };

  it('shares one request between a burst of concurrent callers', async () => {
    const { get, settle, state } = setup({ results: [{ EUR: 0.9 }] });
    const burst = Array.from({ length: 60 }, () => get());
    assert.equal(state.loads, 1);
    settle();
    assert.deepEqual(await Promise.all(burst), Array(60).fill({ EUR: 0.9 }));
    assert.equal(state.loads, 1);
  });

  it('reuses a loaded value until it expires, then loads again', async () => {
    const { get, settle, state } = setup({ results: [1300, 1400] });
    const first = get();
    settle();
    assert.equal(await first, 1300);
    state.time += 59999;
    assert.equal(await get(), 1300);
    assert.equal(state.loads, 1);
    state.time += 1;
    const second = get();
    settle();
    assert.equal(await second, 1400);
    assert.equal(state.loads, 2);
  });

  it('returns null after a failure and does not retry until the delay has passed', async () => {
    const { get, settle, state } = setup({ results: [new Error('HTTP 429'), 1300] });
    const failed = get();
    settle();
    assert.equal(await failed, null);
    assert.deepEqual(state.errors, ['HTTP 429']);
    state.time += 4999;
    assert.equal(await get(), null);
    assert.equal(state.loads, 1);
    state.time += 1;
    const retried = get();
    settle();
    assert.equal(await retried, 1300);
    assert.equal(state.loads, 2);
  });

  it('does not serve an expired value when the refresh fails', async () => {
    const { get, settle, state } = setup({ results: [1300, new Error('stale')] });
    const first = get();
    settle();
    await first;
    state.time += 60000;
    const refresh = get();
    settle();
    assert.equal(await refresh, null);
  });
});

describe('Deposit creation collection', () => {
  it('batches one sell order with every platform from the creation transaction', async () => {
    const scheduled = [];
    const completed = [];
    const collector = createDepositCreationCollector({
      onComplete: async (creation) => completed.push(creation),
      schedule: (callback) => scheduled.push(callback)
    });
    const log = {
      transactionHash: '0x' + 'ab'.repeat(32),
      blockNumber: 12345
    };
    const escrowAddress = CONTRACT_ADDRESSES.escrowV2;

    collector.recordReceived(log, escrowAddress, 17, 250500000n);
    collector.recordPlatform(log, escrowAddress, 17, 'PayPal');
    collector.recordPlatform(log, escrowAddress, 17, 'PayPal');
    collector.recordPlatform(log, escrowAddress, 17, 'Cash App');
    await scheduled[0]();

    assert.deepEqual(completed, [{
      depositId: 17,
      escrowAddress,
      amount: 250500000n,
      platforms: ['PayPal', 'Cash App'],
      blockNumber: 12345
    }]);
  });
});

function encodeLog(iface, eventName, indexedValues, nonIndexedValues, address) {
  const event = iface.getEvent(eventName);
  const topics = [event.topicHash];
  for (const value of indexedValues) {
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 66) {
      topics.push(value);
    } else if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
      topics.push(zeroPadValue(value, 32));
    } else if (typeof value === 'bigint' || typeof value === 'number') {
      topics.push(zeroPadValue(toBeHex(value), 32));
    } else {
      topics.push(value);
    }
  }

  const nonIndexedTypes = event.inputs
    .filter((input) => !input.indexed)
    .map((input) => input.type === 'tuple(uint256,uint256)' ? '(uint256,uint256)' : input.type);

  return {
    address,
    topics,
    data: coder.encode(nonIndexedTypes, nonIndexedValues),
    blockNumber: 12345,
    transactionHash: '0x' + 'ab'.repeat(32)
  };
}

describe('Base deployment configuration', () => {
  it('rejects cleared and oracle-placeholder rates before sniper alerts', () => {
    assert.equal(isQuotedConversionRate(0n), false);
    assert.equal(isQuotedConversionRate(1n), false);
    assert.equal(isQuotedConversionRate(9999999999n), false);
    assert.equal(isQuotedConversionRate(10000000000n), true);
    assert.equal(isQuotedConversionRate(332420988000000000000n), true);
  });

  it('contains the seven independently deployed contracts monitored by the bot', () => {
    assert.equal(Object.keys(CONTRACT_ADDRESSES).length, 7);
    assert.equal(new Set(Object.values(CONTRACT_ADDRESSES).map((value) => value.toLowerCase())).size, 7);
    for (const address of Object.values(CONTRACT_ADDRESSES)) {
      assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('uses the production OrchestratorV3 deployment', () => {
    assert.equal(
      CONTRACT_ADDRESSES.orchestratorV3.toLowerCase(),
      '0x014025fde093f8701d86e9f38e2c3a9b779cb5c7'
    );
  });

  it('uses the production OrchestratorV4 deployment', () => {
    assert.equal(
      CONTRACT_ADDRESSES.orchestratorV4.toLowerCase(),
      '0x74c55679268fafb493864915ad16a320ab8c40ba'
    );
  });

  it('tracks the supported live payment methods', () => {
    assert.deepEqual(Object.keys(ACTIVE_PAYMENT_METHODS).sort(), [
      'alipay',
      'cashapp',
      'chime',
      'mercadopago',
      'monobank',
      'monzo',
      'paypal',
      'revolut',
      'venmo',
      'wise',
      'xmoney',
      'zelle'
    ]);
    assert.equal(
      ACTIVE_PAYMENT_METHODS.zelle,
      '0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3'
    );
    assert.equal(
      ACTIVE_PAYMENT_METHODS.alipay,
      '0xcac9daea62d7b89d75ac73af4ee14dcf25721012ae82b568c2ea5c808eaa04ff'
    );
    assert.equal(
      ACTIVE_PAYMENT_METHODS.xmoney,
      '0x790dd0cc68b6e7f474649a6c0a5463a964be9d2589e2076b6dc99f5701543f51'
    );
  });

  it('derives sniper platforms from active methods only', () => {
    assert.deepEqual([...SUPPORTED_SNIPER_PLATFORMS], Object.keys(ACTIVE_PAYMENT_METHODS).sort());
    assert.equal(SUPPORTED_SNIPER_PLATFORMS.includes('n26'), false);
  });
});

describe('ABI compatibility', () => {
  it('parses all legacy escrow events', () => {
    assert.equal(new Interface(legacyEscrowAbi).fragments.length, 12);
  });

  it('parses modern escrow and EscrowV2 events', () => {
    const escrowNames = new Interface(escrowAbi).fragments.map(({ name }) => name);
    const escrowV2Names = new Interface(escrowV2Abi).fragments.map(({ name }) => name);
    assert.deepEqual(escrowNames, [
      'DepositReceived',
      'DepositCurrencyAdded',
      'DepositPaymentMethodAdded'
    ]);
    assert.ok(escrowV2Names.includes('DepositOracleRateConfigSet'));
    assert.ok(escrowV2Names.includes('DepositFundsAdded'));
    assert.ok(escrowV2Names.includes('DepositClosed'));
  });

  it('keeps O1, O2, and O3 lifecycle event topics compatible', () => {
    const legacy = new Interface(orchestratorAbi);
    const modern = new Interface(modernOrchestratorAbi);
    for (const eventName of ['IntentSignaled', 'IntentFulfilled', 'IntentPruned']) {
      assert.equal(legacy.getEvent(eventName).topicHash, modern.getEvent(eventName).topicHash);
    }
  });

  it('parses an O3 IntentSignaled event', () => {
    const iface = new Interface(modernOrchestratorAbi);
    const intentHash = '0x' + 'aa'.repeat(32);
    const paymentMethod = ACTIVE_PAYMENT_METHODS.zelle;
    const currency = '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e';
    const owner = '0x' + '55'.repeat(20);
    const recipient = '0x' + '66'.repeat(20);
    const log = encodeLog(
      iface,
      'IntentSignaled',
      [intentHash, CONTRACT_ADDRESSES.escrowV2, 10n],
      [paymentMethod, owner, recipient, 500000000n, currency, 920000000000000000n, 1700000000n],
      CONTRACT_ADDRESSES.orchestratorV3
    );

    const parsed = iface.parseLog(log);
    assert.equal(parsed.name, 'IntentSignaled');
    assert.equal(parsed.args.paymentMethod, paymentMethod);
    assert.equal(Number(parsed.args.depositId), 10);
  });

  it('matches the lifecycle topics emitted by the deployed OrchestratorV4', () => {
    const iface = new Interface(orchestratorV4Abi);
    assert.equal(
      iface.getEvent('IntentSignaled').topicHash,
      '0x86d435fa0569b6a642b8faf114b295317d619128afe15d2543e22b250165fc9b'
    );
    assert.equal(
      iface.getEvent('IntentFulfilled').topicHash,
      '0xb41faea6eb34bcf4e3b4bae83094f4d89e0d703af2f1158f334ac98c8cd1a4ca'
    );
    assert.equal(
      iface.getEvent('IntentPruned').topicHash,
      '0x95eadd9e42ccacb548c6389441b53e6eebec39e11adaea9029a25fe1222483e0'
    );
  });

  it('does not parse O4 intent events with the O3 ABI', () => {
    const o3 = new Interface(modernOrchestratorAbi);
    const o4 = new Interface(orchestratorV4Abi);
    for (const eventName of ['IntentSignaled', 'IntentFulfilled']) {
      assert.notEqual(o3.getEvent(eventName).topicHash, o4.getEvent(eventName).topicHash);
    }
  });

  it('parses O4 IntentSignaled and IntentFulfilled events', () => {
    const iface = new Interface(orchestratorV4Abi);
    const intentHash = '0x' + 'bb'.repeat(32);
    const currency = '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e';
    const owner = '0x' + '55'.repeat(20);
    const recipient = '0x' + '66'.repeat(20);
    const signaled = iface.parseLog(encodeLog(
      iface,
      'IntentSignaled',
      [intentHash, CONTRACT_ADDRESSES.escrowV2, 12n],
      [
        ACTIVE_PAYMENT_METHODS.venmo,
        owner,
        recipient,
        25000000n,
        currency,
        1000000000000000000n,
        1700000000n,
        '0x' + '00'.repeat(32),
        '0x' + '00'.repeat(20)
      ],
      CONTRACT_ADDRESSES.orchestratorV4
    ));
    assert.equal(signaled.name, 'IntentSignaled');
    assert.equal(signaled.args.paymentMethod, ACTIVE_PAYMENT_METHODS.venmo);
    assert.equal(Number(signaled.args.depositId), 12);
    assert.equal(signaled.args.amount, 25000000n);

    const fulfilled = iface.parseLog(encodeLog(
      iface,
      'IntentFulfilled',
      [intentHash, recipient],
      [24750000n, owner],
      CONTRACT_ADDRESSES.orchestratorV4
    ));
    assert.equal(fulfilled.name, 'IntentFulfilled');
    assert.equal(fulfilled.args.intentHash, intentHash);
    assert.equal(fulfilled.args.amount, 24750000n);
  });

  it('does not cross-parse legacy and modern escrow currency events', () => {
    const legacy = new Interface(legacyEscrowAbi);
    const modern = new Interface(escrowV2Abi);
    assert.notEqual(
      legacy.getEvent('DepositCurrencyAdded').topicHash,
      modern.getEvent('DepositCurrencyAdded').topicHash
    );
  });
});

describe('Platform resolution', () => {
  it('resolves every active method hash', () => {
    for (const [platform, hash] of Object.entries(ACTIVE_PAYMENT_METHODS)) {
      assert.equal(getPlatformName(hash), platform);
    }
  });

  it('retains historical payment method labels', () => {
    assert.equal(getPlatformName(HISTORICAL_PAYMENT_METHODS.n26), 'n26');
    assert.equal(getPlatformName(HISTORICAL_PAYMENT_METHODS['zelle-citi']), 'zelle');
  });

  it('resolves legacy verifier addresses case-insensitively', () => {
    assert.equal(getPlatformName('0x76D33A33068D86016B806DF02376DDBB23DD3703'), 'cashapp');
  });

  it('returns a safe label for malformed or unknown identifiers', () => {
    assert.equal(getPlatformName(null), 'Unknown');
    assert.match(getPlatformName('0x' + 'de'.repeat(20)), /^Unknown/);
  });
});

describe('Human-readable alerts', () => {
  const timestamp = Date.UTC(2026, 7, 6, 18, 42) / 1000;

  it('summarizes a created buy order without protocol internals', () => {
    const message = buildBuyOrderCreatedMessage({
      platform: 'wise',
      amount: 100000000n,
      conversionRate: 950000000000000000n,
      currencyCode: 'USD',
      timestamp
    });

    assert.equal(message, [
      '🟡 *Buy order created*',
      '',
      '*Platform:* Wise',
      '*From:* $95.00 USD 🇺🇸',
      '*To:* 100.00 USDC',
      '*At:* Aug 6, 2026 at 6:42 PM UTC'
    ].join('\n'));
    for (const noisyLabel of ['Deposit ID', 'Order ID', 'Owner', 'Block', 'BaseScan']) {
      assert.equal(message.includes(noisyLabel), false);
    }
  });

  it('summarizes a created sell order with its USDC amount and platforms', () => {
    const message = buildSellOrderCreatedMessage({
      amount: 250500000n,
      platforms: ['paypal', 'cashapp'],
      timestamp
    });

    assert.equal(message, [
      '🔵 *Sell order created*',
      '',
      '*Amount:* 250.50 USDC',
      '*Platforms:* PayPal, Cash App',
      '*At:* Aug 6, 2026 at 6:42 PM UTC'
    ].join('\n'));
  });

  it('summarizes snipe and 1:1 opportunities consistently', () => {
    const snipe = buildSniperMessage({
      amount: 100000000n,
      conversionRate: 950000000000000000n,
      platform: 'paypal',
      currencyCode: 'USD',
      marketRate: 1,
      isOneToOne: false,
      timestamp
    });
    const parity = buildSniperMessage({
      amount: 100000000n,
      conversionRate: 1000000000000000000n,
      platform: 'cashapp',
      currencyCode: 'USD',
      marketRate: 1,
      isOneToOne: true,
      timestamp
    });

    assert.equal(snipe, [
      '🎯 *Snipe opportunity*',
      '',
      '*Platform:* PayPal',
      '*Pay:* $95.00 USD 🇺🇸',
      '*Receive:* 100.00 USDC (= ~$100.00 USD 🇺🇸)',
      '*Profit:* ~$5.00 USD',
      '*Found:* Aug 6, 2026 at 6:42 PM UTC',
      '',
      '[Download the mobile app](https://mobile.zkp2p.xyz/onboard) to receive faster notifications and snipe on the go.'
    ].join('\n'));
    assert.match(parity, /\*Platform:\* Cash App/);
    assert.match(parity, /\*Pay:\* \$100\.00 USD 🇺🇸/);
    assert.equal(parity.includes('*Profit:*'), false);
  });

  it('renders Monobank UAH sniper alerts from the deployed payment method', () => {
    const platform = getPlatformName('0x1d966dbd6aeb8674d7c05174bd0ded7b56a798672bfb862ef20bbe8c2bbfce18');
    assert.equal(platform, 'monobank');
    assert.equal(SUPPORTED_SNIPER_PLATFORMS.includes(platform), true);
    const message = buildSniperMessage({
      platform,
      amount: 100000000n,
      conversionRate: 40000000000000000000n,
      marketRate: 42,
      currencyCode: 'UAH',
      isOneToOne: false,
      timestamp
    });
    assert.match(message, /\*Platform:\* Monobank/);
    assert.match(message, /\*Pay:\* ₴4,000\.00 UAH 🇺🇦/);
    assert.match(message, /\*Receive:\* 100\.00 USDC \(= ~₴4,200\.00 UAH 🇺🇦\)/);
    assert.match(message, /\*Profit:\* ~\$4\.76 USD/);
  });

  it('only shows snipe profit when its USD value exceeds one dollar', () => {
    const exactlyOneDollar = buildSniperMessage({
      amount: 100000000n,
      conversionRate: 990000000000000000n,
      marketRate: 1,
      currencyCode: 'USD',
      isOneToOne: false,
      timestamp
    });
    const fiveDollarEuroProfit = buildSniperMessage({
      amount: 100000000n,
      conversionRate: 855000000000000000n,
      marketRate: 0.9,
      currencyCode: 'EUR',
      isOneToOne: false,
      timestamp
    });

    assert.equal(exactlyOneDollar.includes('*Profit:*'), false);
    assert.match(fiveDollarEuroProfit, /\*Pay:\* €85\.50 EUR 🇪🇺/);
    assert.match(fiveDollarEuroProfit, /\*Receive:\* 100\.00 USDC \(= ~€90\.00 EUR 🇪🇺\)/);
    assert.match(fiveDollarEuroProfit, /\*Profit:\* ~\$5\.00 USD/);
  });

  it('keeps lifecycle updates concise and human-readable', () => {
    const eventTimestamp = Date.UTC(2026, 7, 6, 20, 7) / 1000;
    const fulfilled = buildBuyOrderStatusMessage({
      status: 'fulfilled',
      platform: 'paypal',
      amount: 25000000n,
      conversionRate: 1000000000000000000n,
      currencyCode: 'USD',
      signalTimestamp: timestamp,
      eventTimestamp
    });
    const cancelled = buildBuyOrderStatusMessage({
      status: 'cancelled',
      platform: 'wise',
      amount: 25000000n,
      conversionRate: 1000000000000000000n,
      currencyCode: 'USD',
      signalTimestamp: timestamp,
      eventTimestamp
    });

    assert.equal(fulfilled, [
      '🟢 *Buy order fulfilled*',
      '',
      '*Platform:* PayPal',
      '*From:* $25.00 USD 🇺🇸',
      '*To:* 25.00 USDC',
      '*At:* Aug 6, 2026 at 8:07 PM UTC',
      '*Fulfilled in:* 1h 25m'
    ].join('\n'));
    assert.equal(cancelled, [
      '🟠 *Buy order cancelled*',
      '',
      '*Platform:* Wise',
      '*From:* $25.00 USD 🇺🇸',
      '*To:* 25.00 USDC',
      '*At:* Aug 6, 2026 at 8:07 PM UTC'
    ].join('\n'));
    assert.equal(formatElapsedTime(timestamp, timestamp + 300), '5m');
    assert.equal(formatElapsedTime(timestamp, timestamp + 30), '<1m');
    assert.equal(formatPlatform('Unknown (0x1234...5678)'), 'Payment app');
    assert.equal(formatPlatform('xmoney'), 'X Money');
  });

  it('links sell order and deposit event alerts to the explorer sell page', () => {
    assert.deepEqual(createPeerExplorerSellKeyboard(CONTRACT_ADDRESSES.escrowV2.toUpperCase(), 17), {
      inline_keyboard: [[{
        text: 'View on Peer',
        url: `https://app.peer.xyz/explorer/sell/${CONTRACT_ADDRESSES.escrowV2.toLowerCase()}_17`
      }]]
    });
    assert.equal(
      createPeerExplorerSellKeyboard(undefined, 17).inline_keyboard[0][0].url,
      'https://app.peer.xyz/activity?q=17'
    );
  });

  it('links buy order alerts to the explorer buy page', () => {
    const intentHash = '0x' + 'AB'.repeat(32);
    const iface = new Interface(modernOrchestratorAbi);
    const log = encodeLog(
      iface,
      'IntentPruned',
      [intentHash],
      [],
      CONTRACT_ADDRESSES.orchestratorV3
    );
    const buyUrl = 'https://app.peer.xyz/explorer/buy/0x' + 'ab'.repeat(32);

    assert.deepEqual(createPeerExplorerBuyKeyboard(iface.parseLog(log).args.intentHash), {
      inline_keyboard: [[{ text: 'View on Peer', url: buyUrl }]]
    });
    assert.equal(peerExplorerBuyUrl(intentHash), buyUrl);
    assert.equal(peerExplorerBuyUrl('0x123'), 'https://app.peer.xyz/activity?q=0x123');
  });

  it('keeps snipe alerts on the web deposit page', () => {
    assert.deepEqual(createTakeOnWebKeyboard(CONTRACT_ADDRESSES.escrowV2, 17), {
      inline_keyboard: [[{
        text: 'Take on web',
        url: `https://app.peer.xyz/deposit/${CONTRACT_ADDRESSES.escrowV2.toLowerCase()}/17`
      }]]
    });
    assert.equal(
      createTakeOnWebKeyboard().inline_keyboard[0][0].url,
      'https://app.peer.xyz/deposits'
    );
  });
});

describe('Shared WebSocket routing', () => {
  it('routes all seven contract addresses through one address router', async () => {
    const calls = [];
    const router = createAddressRouter(
      Object.entries(CONTRACT_ADDRESSES).map(([name, address]) => ({
        name,
        address,
        handler: async (log) => calls.push([name, log.blockNumber])
      }))
    );

    for (const [name, address] of Object.entries(CONTRACT_ADDRESSES)) {
      const routed = await router.route({ address, blockNumber: 100 });
      assert.equal(routed, true, name);
    }
    assert.equal(calls.length, 7);
    assert.equal(router.addresses.length, 7);
  });

  it('ignores logs from unknown contracts', async () => {
    const router = createAddressRouter([{
      name: 'O3',
      address: CONTRACT_ADDRESSES.orchestratorV3,
      handler: async () => assert.fail('handler should not run')
    }]);
    assert.equal(await router.route({ address: '0x' + '11'.repeat(20) }), false);
  });

  it('rejects duplicate subscriptions', () => {
    const subscription = {
      name: 'O3',
      address: CONTRACT_ADDRESSES.orchestratorV3,
      handler: async () => {}
    };
    assert.throws(
      () => createAddressRouter([subscription, { ...subscription, name: 'duplicate' }]),
      /Duplicate contract subscription/
    );
  });

  it('contains handler failures without rejecting the event stream', async () => {
    const errors = [];
    const router = createAddressRouter([{
      name: 'O3',
      address: CONTRACT_ADDRESSES.orchestratorV3,
      handler: async () => { throw new Error('boom'); }
    }], (...args) => errors.push(args));

    assert.equal(await router.route({ address: CONTRACT_ADDRESSES.orchestratorV3 }), true);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /O3/);
  });
});

describe('Escrow event parsing and accounting primitives', () => {
  it('parses EscrowV2 DepositReceived with delegate and guardian', () => {
    const iface = new Interface(escrowV2Abi);
    const depositor = '0x' + '11'.repeat(20);
    const token = '0x' + '22'.repeat(20);
    const delegate = '0x' + '33'.repeat(20);
    const guardian = '0x' + '44'.repeat(20);
    const log = encodeLog(
      iface,
      'DepositReceived',
      [5n, depositor, token],
      [1000000n, [100n, 500n], delegate, guardian],
      CONTRACT_ADDRESSES.escrowV2
    );
    const parsed = iface.parseLog(log);
    assert.equal(parsed.args.delegate, delegate);
    assert.equal(parsed.args.intentGuardian, guardian);
  });

  it('parses oracle config with a negative spread', () => {
    const iface = new Interface(escrowV2Abi);
    const currency = '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907';
    const adapter = '0x53881a928abD61C095e5f30b63bc554872C3b2f1';
    const log = encodeLog(
      iface,
      'DepositOracleRateConfigSet',
      [10n, ACTIVE_PAYMENT_METHODS.revolut, currency],
      [adapter, '0x00', -50, 3600],
      CONTRACT_ADDRESSES.escrowV2
    );
    assert.equal(Number(iface.parseLog(log).args.spreadBps), -50);
  });

  it('keeps independent amount caches for colliding deposit IDs', () => {
    const legacy = new Map([[5, 1000000]]);
    const escrow = new Map([[5, 3000000]]);
    const escrowV2 = new Map([[5, 7000000]]);
    assert.deepEqual([legacy.get(5), escrow.get(5), escrowV2.get(5)], [1000000, 3000000, 7000000]);
  });

  it('computes positive and negative oracle spreads exactly', () => {
    const rate = 1000000000000000000n;
    const positive = (rate * BigInt(10100)) / 10000n;
    const negative = (rate * BigInt(9950)) / 10000n;
    assert.equal(positive, 1010000000000000000n);
    assert.equal(negative, 995000000000000000n);
  });
});
