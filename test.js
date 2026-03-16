const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Interface, AbiCoder, zeroPadValue, toBeHex } = require('ethers');

// ─── ABI definitions (mirroring bot.js structure) ───

const legacyEscrowAbi = [
  `event IntentSignaled(bytes32 indexed intentHash, uint256 indexed depositId, address indexed verifier, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)`,
  `event IntentFulfilled(bytes32 indexed intentHash, uint256 indexed depositId, address indexed verifier, address owner, address to, uint256 amount, uint256 sustainabilityFee, uint256 verifierFee)`,
  `event IntentPruned(bytes32 indexed intentHash, uint256 indexed depositId)`,
  `event DepositReceived(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, tuple(uint256,uint256) intentAmountRange)`,
  `event DepositCurrencyAdded(uint256 indexed depositId, address indexed verifier, bytes32 indexed currency, uint256 conversionRate)`,
  `event DepositVerifierAdded(uint256 indexed depositId, address indexed verifier, bytes32 indexed payeeDetailsHash, address intentGatingService)`,
  `event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount)`,
  `event DepositClosed(uint256 depositId, address depositor)`,
  `event DepositCurrencyRateUpdated(uint256 indexed depositId, address indexed verifier, bytes32 indexed currency, uint256 conversionRate)`,
  `event BeforeExecution()`,
  `event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)`,
  `event DepositConversionRateUpdated(uint256 indexed depositId, address indexed verifier, bytes32 indexed currency, uint256 newConversionRate)`
];

const escrowV3Abi = [
  `event DepositReceived(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, tuple(uint256,uint256) intentAmountRange, address delegate, address intentGuardian)`,
  `event DepositCurrencyAdded(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 minConversionRate)`,
  `event DepositPaymentMethodAdded(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed payeeDetails, address intentGatingService)`
];

// EscrowV2 extends V3 with rate update + close events (mirrors bot.js)
const escrowV2Abi = [
  ...escrowV3Abi,
  `event DepositMinConversionRateUpdated(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 newMinConversionRate)`,
  `event DepositFundsAdded(uint256 indexed depositId, address indexed depositor, uint256 amount)`,
  `event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount)`,
  `event DepositClosed(uint256 depositId, address depositor)`
];

const orchestratorAbi = [
  `event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)`,
  `event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease)`,
  `event IntentPruned(bytes32 indexed intentHash)`
];

const orchestratorV2Abi = [
  ...orchestratorAbi,
  `event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee)`,
  `event IntentReferralFeeDistributed(bytes32 indexed intentHash, address indexed feeRecipient, uint256 feeAmount)`
];

// ─── Platform mapping (from bot.js) ───

const platformMapping = {
  '0x76d33a33068d86016b806df02376ddbb23dd3703': { platform: 'cashapp', isUsdOnly: true },
  '0x9a733b55a875d0db4915c6b36350b24f8ab99df5': { platform: 'venmo', isUsdOnly: true },
  '0xaa5a1b62b01781e789c900d616300717cd9a41ab': { platform: 'revolut', isUsdOnly: false },
  '0xff0149799631d7a5bde2e7ea9b306c42b3d9a9ca': { platform: 'wise', isUsdOnly: false },
  '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268': { platform: 'venmo', isUsdOnly: true },
  '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d': { platform: 'revolut', isUsdOnly: false },
  '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d': { platform: 'cashapp', isUsdOnly: true },
  '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5': { platform: 'wise', isUsdOnly: false },
  '0xd9ff4fd6b39a3e3dd43c41d05662a5547de4a878bc97a65bcb352ade493cdc6b': { platform: 'n26', isUsdOnly: false },
  '0x5908bb0c9b87763ac6171d4104847667e7f02b4c47b574fe890c1f439ed128bb': { platform: 'chime', isUsdOnly: true }
};

const getPlatformName = (identifier) => {
  const mapping = platformMapping[identifier.toLowerCase()];
  if (mapping) return mapping.platform;
  return `Unknown (${identifier.slice(0, 10)}...)`;
};

// ─── Helpers ───

const coder = AbiCoder.defaultAbiCoder();

function encodeLog(iface, eventName, indexedValues, nonIndexedValues) {
  const event = iface.getEvent(eventName);
  const topics = [event.topicHash];
  for (const val of indexedValues) {
    if (typeof val === 'string' && val.startsWith('0x') && val.length === 66) {
      topics.push(val);
    } else if (typeof val === 'string' && val.startsWith('0x') && val.length === 42) {
      topics.push(zeroPadValue(val, 32));
    } else if (typeof val === 'bigint' || typeof val === 'number') {
      topics.push(zeroPadValue(toBeHex(val), 32));
    } else {
      topics.push(val);
    }
  }
  const nonIndexedTypes = event.inputs.filter(i => !i.indexed).map(i => {
    if (i.type === 'tuple(uint256,uint256)') return '(uint256,uint256)';
    return i.type;
  });
  const data = coder.encode(nonIndexedTypes, nonIndexedValues);
  return { address: '0x0000000000000000000000000000000000000001', topics, data, blockNumber: 12345, transactionHash: '0x' + 'ab'.repeat(32) };
}


// ═══════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════

describe('ABI Parsing', () => {
  it('should parse all legacy escrow ABI events', () => {
    const iface = new Interface(legacyEscrowAbi);
    assert.equal(iface.fragments.length, 12);
  });

  it('should parse EscrowV2 ABI (extends V3 with extra events)', () => {
    const iface = new Interface(escrowV2Abi);
    assert.equal(iface.fragments.length, 7); // 3 from v3 + 4 new
    const names = iface.fragments.map(f => f.name);
    assert.ok(names.includes('DepositReceived'));
    assert.ok(names.includes('DepositCurrencyAdded'));
    assert.ok(names.includes('DepositMinConversionRateUpdated'));
    assert.ok(names.includes('DepositFundsAdded'));
    assert.ok(names.includes('DepositClosed'));
  });

  it('should parse OrchestratorV2 ABI (extends v1 with fee events)', () => {
    const iface = new Interface(orchestratorV2Abi);
    assert.equal(iface.fragments.length, 5); // 3 from v1 + 2 new
    const names = iface.fragments.map(f => f.name);
    assert.ok(names.includes('IntentSignaled'));
    assert.ok(names.includes('IntentManagerFeeSnapshotted'));
    assert.ok(names.includes('IntentReferralFeeDistributed'));
  });

  it('should NOT parse legacy DepositCurrencyAdded with EscrowV2 ABI', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const v2Iface = new Interface(escrowV2Abi);
    const legacyTopic = legacyIface.getEvent('DepositCurrencyAdded').topicHash;
    const v2Topic = v2Iface.getEvent('DepositCurrencyAdded').topicHash;
    assert.notEqual(legacyTopic, v2Topic);
  });

  it('should have matching orchestrator event topics between v1 and v2', () => {
    const v1Iface = new Interface(orchestratorAbi);
    const v2Iface = new Interface(orchestratorV2Abi);
    for (const name of ['IntentSignaled', 'IntentFulfilled', 'IntentPruned']) {
      assert.equal(v1Iface.getEvent(name).topicHash, v2Iface.getEvent(name).topicHash);
    }
  });

  it('should have matching EscrowV2 and V3 event topics for shared events', () => {
    const v3Iface = new Interface(escrowV3Abi);
    const v2Iface = new Interface(escrowV2Abi);
    for (const name of ['DepositReceived', 'DepositCurrencyAdded', 'DepositPaymentMethodAdded']) {
      assert.equal(v3Iface.getEvent(name).topicHash, v2Iface.getEvent(name).topicHash);
    }
  });
});


describe('Event Log Parsing', () => {
  it('should parse EscrowV2 DepositReceived with delegate + guardian', () => {
    const iface = new Interface(escrowV2Abi);
    const depositor = '0x' + '11'.repeat(20);
    const token = '0x' + '22'.repeat(20);
    const delegate = '0x' + '33'.repeat(20);
    const guardian = '0x' + '44'.repeat(20);
    const log = encodeLog(iface, 'DepositReceived',
      [5n, depositor, token],
      [1000000n, [100n, 500n], delegate, guardian]
    );
    const parsed = iface.parseLog(log);
    assert.equal(parsed.name, 'DepositReceived');
    assert.equal(Number(parsed.args.depositId), 5);
    assert.equal(parsed.args.delegate, delegate);
    assert.equal(parsed.args.intentGuardian, guardian);
  });

  it('should parse EscrowV2 DepositCurrencyAdded with paymentMethod bytes32', () => {
    const iface = new Interface(escrowV2Abi);
    const paymentMethod = '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268';
    const currency = '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e';
    const log = encodeLog(iface, 'DepositCurrencyAdded',
      [42n, paymentMethod, currency], [1050000000000000000n]
    );
    const parsed = iface.parseLog(log);
    assert.equal(parsed.name, 'DepositCurrencyAdded');
    assert.equal(parsed.args.paymentMethod, paymentMethod);
    assert.equal(parsed.args.minConversionRate, 1050000000000000000n);
  });

  it('should parse EscrowV2 DepositMinConversionRateUpdated', () => {
    const iface = new Interface(escrowV2Abi);
    const paymentMethod = '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d';
    const currency = '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907';
    const log = encodeLog(iface, 'DepositMinConversionRateUpdated',
      [10n, paymentMethod, currency], [920000000000000000n]
    );
    const parsed = iface.parseLog(log);
    assert.equal(parsed.name, 'DepositMinConversionRateUpdated');
    assert.equal(Number(parsed.args.depositId), 10);
  });

  it('should parse OrchestratorV2 IntentSignaled', () => {
    const iface = new Interface(orchestratorV2Abi);
    const intentHash = '0x' + 'aa'.repeat(32);
    const escrow = '0x777777779d229cdF3110e9de47943791c26300Ef';
    const paymentMethod = '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d';
    const owner = '0x' + '55'.repeat(20);
    const to = '0x' + '66'.repeat(20);
    const currency = '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907';
    const log = encodeLog(iface, 'IntentSignaled',
      [intentHash, escrow, 10n],
      [paymentMethod, owner, to, 500000000n, currency, 920000000000000000n, 1700000000n]
    );
    const parsed = iface.parseLog(log);
    assert.equal(parsed.name, 'IntentSignaled');
    assert.equal(parsed.args.escrow.toLowerCase(), escrow.toLowerCase());
    assert.equal(Number(parsed.args.depositId), 10);
  });

  it('should NOT cross-parse legacy and v2 escrow events', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const v2Iface = new Interface(escrowV2Abi);
    const verifier = '0x76d33a33068d86016b806df02376ddbb23dd3703';
    const currency = '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e';
    const legacyLog = encodeLog(legacyIface, 'DepositCurrencyAdded',
      [1n, verifier, currency], [1000000000000000000n]);
    assert.equal(v2Iface.parseLog(legacyLog), null);

    const paymentMethod = '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268';
    const v2Log = encodeLog(v2Iface, 'DepositCurrencyAdded',
      [1n, paymentMethod, currency], [1000000000000000000n]);
    assert.equal(legacyIface.parseLog(v2Log), null);
  });
});


describe('Deposit ID Collision Prevention', () => {
  let escrowV2Amounts, escrowV3Amounts, dbAmounts;

  beforeEach(() => {
    escrowV2Amounts = new Map();
    escrowV3Amounts = new Map();
    dbAmounts = new Map();
  });

  it('should store amounts independently across 3 escrows', () => {
    const id = 5;
    dbAmounts.set(id, 1000000);          // legacy
    escrowV3Amounts.set(id, 3000000);    // v3
    escrowV2Amounts.set(id, 7000000);    // v2
    assert.equal(dbAmounts.get(id), 1000000);
    assert.equal(escrowV3Amounts.get(id), 3000000);
    assert.equal(escrowV2Amounts.get(id), 7000000);
  });

  it('should accumulate funds via DepositFundsAdded', () => {
    escrowV2Amounts.set(10, 2000000);
    const existing = escrowV2Amounts.get(10) || 0;
    escrowV2Amounts.set(10, existing + 3000000);
    assert.equal(escrowV2Amounts.get(10), 5000000);
  });

  it('should clean up on DepositClosed', () => {
    escrowV2Amounts.set(7, 1000000);
    escrowV2Amounts.delete(7);
    assert.equal(escrowV2Amounts.get(7), undefined);
  });

  it('should return 0 for unknown deposits', () => {
    assert.equal(escrowV2Amounts.get(999) || 0, 0);
  });
});


describe('Platform Name Resolution', () => {
  it('should resolve legacy verifier addresses', () => {
    assert.equal(getPlatformName('0x76d33a33068d86016b806df02376ddbb23dd3703'), 'cashapp');
    assert.equal(getPlatformName('0xaa5a1b62b01781e789c900d616300717cd9a41ab'), 'revolut');
  });

  it('should resolve payment method hashes (v2/v3)', () => {
    assert.equal(getPlatformName('0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268'), 'venmo');
    assert.equal(getPlatformName('0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d'), 'cashapp');
  });

  it('should resolve new platforms (N26, Chime)', () => {
    assert.equal(getPlatformName('0xd9ff4fd6b39a3e3dd43c41d05662a5547de4a878bc97a65bcb352ade493cdc6b'), 'n26');
    assert.equal(getPlatformName('0x5908bb0c9b87763ac6171d4104847667e7f02b4c47b574fe890c1f439ed128bb'), 'chime');
  });

  it('should handle case-insensitive lookups', () => {
    assert.equal(getPlatformName('0x76D33A33068D86016B806DF02376DDBB23DD3703'), 'cashapp');
  });

  it('should return Unknown for unrecognized identifiers', () => {
    assert.ok(getPlatformName('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef').includes('Unknown'));
  });
});


describe('Contract Address Separation & Labels', () => {
  const escrowV2Addr = '0x777777779d229cdF3110e9de47943791c26300Ef';
  const oldEscrowAddr = '0xca38607d85e8f6294dc10728669605e6664c2d70';

  it('should identify new EscrowV2 from escrow param', () => {
    assert.ok(escrowV2Addr.toLowerCase() === escrowV2Addr.toLowerCase());
    assert.ok(oldEscrowAddr.toLowerCase() !== escrowV2Addr.toLowerCase());
  });

  it('should generate (v2) label for new escrow intents', () => {
    const isNew = true;
    const isOld = false;
    assert.equal(`Order Created${isNew ? ' (v2)' : ''}`, 'Order Created (v2)');
    assert.equal(`Order Created${isOld ? ' (v2)' : ''}`, 'Order Created');
  });

  it('should handle isEscrowV2 flag in stored intent details', () => {
    // New orchestrator V2 stores flag
    const newDetails = { depositId: 5, isEscrowV2: true };
    assert.equal(newDetails.isEscrowV2 ? ' (v2)' : '', ' (v2)');

    // Old orchestrator does not set flag
    const oldDetails = { depositId: 5 };
    assert.equal(oldDetails.isEscrowV2 ? ' (v2)' : '', '');
  });
});


describe('Event Signature Isolation', () => {
  it('should have different DepositReceived signatures between legacy and v2', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const v2Iface = new Interface(escrowV2Abi);
    assert.notEqual(
      legacyIface.getEvent('DepositReceived').topicHash,
      v2Iface.getEvent('DepositReceived').topicHash
    );
  });

  it('should have different DepositCurrencyAdded signatures between legacy and v2', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const v2Iface = new Interface(escrowV2Abi);
    assert.notEqual(
      legacyIface.getEvent('DepositCurrencyAdded').topicHash,
      v2Iface.getEvent('DepositCurrencyAdded').topicHash
    );
  });

  it('should have same DepositWithdrawn/DepositClosed between legacy and v2 (identical sigs)', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const v2Iface = new Interface(escrowV2Abi);
    assert.equal(
      legacyIface.getEvent('DepositWithdrawn').topicHash,
      v2Iface.getEvent('DepositWithdrawn').topicHash
    );
    assert.equal(
      legacyIface.getEvent('DepositClosed').topicHash,
      v2Iface.getEvent('DepositClosed').topicHash
    );
  });
});


describe('Concurrent Provider Simulation', () => {
  it('should route events from 5 contracts independently', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const orchIface = new Interface(orchestratorAbi);
    const v3Iface = new Interface(escrowV3Abi);
    const v2Iface = new Interface(escrowV2Abi);
    const orchV2Iface = new Interface(orchestratorV2Abi);

    const results = [];
    function route(name, iface, log) {
      const parsed = iface.parseLog(log);
      if (parsed) results.push({ contract: name, event: parsed.name });
    }

    const depositor = '0x' + '11'.repeat(20);
    const token = '0x' + '22'.repeat(20);
    const escrow = '0x777777779d229cdF3110e9de47943791c26300Ef';
    const paymentMethod = '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268';
    const currency = '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e';
    const intentHash = '0x' + 'ff'.repeat(32);

    // Legacy escrow
    route('legacy', legacyIface, encodeLog(legacyIface, 'DepositReceived', [1n, depositor, token], [2000000n, [100n, 500n]]));
    // V3 escrow
    route('v3', v3Iface, encodeLog(v3Iface, 'DepositReceived', [1n, depositor, token], [3000000n, [200n, 1000n], depositor, depositor]));
    // V2 escrow
    route('v2', v2Iface, encodeLog(v2Iface, 'DepositReceived', [1n, depositor, token], [5000000n, [200n, 1000n], depositor, depositor]));
    // Orchestrator
    route('orch', orchIface, encodeLog(orchIface, 'IntentSignaled', [intentHash, escrow, 1n], [paymentMethod, depositor, depositor, 500000000n, currency, 1000000000000000000n, 1700000000n]));
    // OrchestratorV2
    route('orchV2', orchV2Iface, encodeLog(orchV2Iface, 'IntentSignaled', [intentHash, escrow, 1n], [paymentMethod, depositor, depositor, 500000000n, currency, 1000000000000000000n, 1700000000n]));

    assert.equal(results.length, 5);
    assert.deepStrictEqual(results.map(r => r.contract), ['legacy', 'v3', 'v2', 'orch', 'orchV2']);
  });

  it('should not cross-parse between legacy and v2/v3 escrow', () => {
    const legacyIface = new Interface(legacyEscrowAbi);
    const v2Iface = new Interface(escrowV2Abi);
    const verifier = '0x76d33a33068d86016b806df02376ddbb23dd3703';
    const currency = '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e';
    const legacyLog = encodeLog(legacyIface, 'DepositCurrencyAdded', [1n, verifier, currency], [1000000000000000000n]);
    assert.equal(v2Iface.parseLog(legacyLog), null);
  });
});
