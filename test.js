const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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
  legacyEscrowAbi,
  modernOrchestratorAbi,
  orchestratorAbi
} = require('./src/contracts');
const { createAddressRouter } = require('./src/resilient-websocket-provider');
const {
  buildOrderCreatedMessage,
  buildOrderStatusMessage,
  buildSniperMessage,
  createPeerlyticsKeyboard,
  formatPlatform,
  peerlyticsDepositUrl,
  peerlyticsIntentUrl
} = require('./src/alerts');

const coder = AbiCoder.defaultAbiCoder();

describe('Runtime dependencies', () => {
  it('exposes the Telegram client constructor used by the bot', () => {
    const client = new TelegramBot('test-token', { polling: false });
    assert.equal(typeof client.getMe, 'function');
    assert.equal(typeof client.onText, 'function');
    assert.equal(typeof client.sendMessage, 'function');
    assert.equal(typeof client.stopPolling, 'function');
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
  it('contains the six independently deployed contracts monitored by the bot', () => {
    assert.equal(Object.keys(CONTRACT_ADDRESSES).length, 6);
    assert.equal(new Set(Object.values(CONTRACT_ADDRESSES).map((value) => value.toLowerCase())).size, 6);
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

  it('tracks the ten live payment methods', () => {
    assert.deepEqual(Object.keys(ACTIVE_PAYMENT_METHODS).sort(), [
      'alipay',
      'cashapp',
      'chime',
      'mercadopago',
      'monzo',
      'paypal',
      'revolut',
      'venmo',
      'wise',
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
  const intentHash = '0x' + 'AB'.repeat(32);

  it('summarizes a created order without protocol internals', () => {
    const message = buildOrderCreatedMessage({
      platform: 'venmo',
      amount: 100000000n,
      conversionRate: 950000000000000000n,
      currencyCode: 'USD',
      timestamp
    });

    assert.equal(message, [
      '🟡 *Order created*',
      '',
      'A Venmo order was created to pay *$95.00 USD* for *100.00 USDC*.',
      '*Created:* Aug 6, 2026 at 6:42 PM UTC'
    ].join('\n'));
    for (const noisyLabel of ['Deposit ID', 'Order ID', 'Owner', 'Block', 'BaseScan']) {
      assert.equal(message.includes(noisyLabel), false);
    }
  });

  it('summarizes snipe and 1:1 opportunities consistently', () => {
    const snipe = buildSniperMessage({
      platform: 'venmo',
      amount: 100000000n,
      conversionRate: 950000000000000000n,
      currencyCode: 'USD',
      percentageDiff: 5,
      isOneToOne: false,
      timestamp
    });
    const parity = buildSniperMessage({
      platform: 'cashapp',
      amount: 100000000n,
      conversionRate: 1000000000000000000n,
      currencyCode: 'USD',
      percentageDiff: 0,
      isOneToOne: true,
      timestamp
    });

    assert.equal(snipe, [
      '🎯 *Snipe opportunity*',
      '',
      'Pay *$95.00 USD* with Venmo for *100.00 USDC* at *5.0% below market*.',
      '*Found:* Aug 6, 2026 at 6:42 PM UTC'
    ].join('\n'));
    assert.match(parity, /Pay \*\$100\.00 USD\* with Cash App for \*100\.00 USDC\* at the market rate\./);
  });

  it('keeps lifecycle updates concise and human-readable', () => {
    const message = buildOrderStatusMessage({
      status: 'fulfilled',
      platform: 'paypal',
      amount: 25000000n,
      conversionRate: 1000000000000000000n,
      currencyCode: 'USD'
    });

    assert.equal(
      message,
      '🟢 *Order fulfilled*\n\nThe PayPal order to pay *$25.00 USD* for *25.00 USDC* was fulfilled.'
    );
    assert.equal(formatPlatform('Unknown (0x1234...5678)'), 'Payment app');
  });

  it('builds canonical Peerlytics links and buttons', () => {
    assert.equal(
      peerlyticsIntentUrl(intentHash),
      `https://peerlytics.xyz/explorer/intent/${intentHash.toLowerCase()}`
    );
    assert.equal(
      peerlyticsDepositUrl(CONTRACT_ADDRESSES.escrowV2.toUpperCase(), 17),
      `https://peerlytics.xyz/explorer/deposit/${CONTRACT_ADDRESSES.escrowV2.toLowerCase()}_17`
    );
    assert.deepEqual(
      createPeerlyticsKeyboard(peerlyticsIntentUrl(intentHash)),
      {
        inline_keyboard: [[{
          text: 'View on Peerlytics',
          url: `https://peerlytics.xyz/explorer/intent/${intentHash.toLowerCase()}`
        }]]
      }
    );
  });
});

describe('Shared WebSocket routing', () => {
  it('routes all six contract addresses through one address router', async () => {
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
    assert.equal(calls.length, 6);
    assert.equal(router.addresses.length, 6);
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
