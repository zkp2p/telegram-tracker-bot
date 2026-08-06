const CONTRACT_ADDRESSES = Object.freeze({
  legacyEscrow: '0xca38607d85e8f6294dc10728669605e6664c2d70',
  escrow: '0x2f121CDDCA6d652f35e8B3E560f9760898888888',
  escrowV2: '0x777777779d229cdF3110e9de47943791c26300Ef',
  orchestrator: '0x88888883Ed048FF0a415271B28b2F52d431810D0',
  orchestratorV2: '0x888888359E981B5225CA48fbCdCeff702FC3b888',
  orchestratorV3: '0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7'
});

// Active Base payment methods from zkp2p-contracts deployment outputs and the
// live PaymentVerifierRegistry. Keep historical identifiers below so delayed
// events and old deposits still render with a useful platform name.
const ACTIVE_PAYMENT_METHODS = Object.freeze({
  alipay: '0xcac9daea62d7b89d75ac73af4ee14dcf25721012ae82b568c2ea5c808eaa04ff',
  cashapp: '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d',
  chime: '0x5908bb0c9b87763ac6171d4104847667e7f02b4c47b574fe890c1f439ed128bb',
  mercadopago: '0xa5418819c024239299ea32e09defae8ec412c03e58f5c75f1b2fe84c857f5483',
  monzo: '0x62c7ed738ad3e7618111348af32691b5767777fbaf46a2d8943237625552645c',
  paypal: '0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f',
  revolut: '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d',
  venmo: '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268',
  wise: '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5',
  zelle: '0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3'
});

const HISTORICAL_PAYMENT_METHODS = Object.freeze({
  n26: '0xd9ff4fd6b39a3e3dd43c41d05662a5547de4a878bc97a65bcb352ade493cdc6b',
  'zelle-bofa': '0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5',
  'zelle-chase': '0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e',
  'zelle-citi': '0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d'
});

const LEGACY_VERIFIERS = Object.freeze({
  cashapp: '0x76d33a33068d86016b806df02376ddbb23dd3703',
  mercadopago: '0xf2ac5be14f32cbe6a613cff8931d95460d6c33a3',
  monzo: '0x0de46433bd251027f73ed8f28e01ef05da36a2e0',
  paypal: '0x03d17e9371c858072e171276979f6b44571c5dea',
  revolut: '0xaa5a1b62b01781e789c900d616300717cd9a41ab',
  venmo: '0x9a733b55a875d0db4915c6b36350b24f8ab99df5',
  wise: '0xff0149799631d7a5bde2e7ea9b306c42b3d9a9ca',
  zelle: '0x431a078a5029146aab239c768a615cd484519af7'
});

const platformMapping = Object.freeze(Object.fromEntries([
  ...Object.entries(LEGACY_VERIFIERS),
  ...Object.entries(ACTIVE_PAYMENT_METHODS),
  ...Object.entries(HISTORICAL_PAYMENT_METHODS)
].map(([platform, identifier]) => [
  identifier.toLowerCase(),
  { platform: platform.startsWith('zelle') ? 'zelle' : platform }
])));

const SUPPORTED_SNIPER_PLATFORMS = Object.freeze(
  [...new Set(Object.keys(ACTIVE_PAYMENT_METHODS))].sort()
);

function getPlatformName(identifier) {
  if (typeof identifier !== 'string') return 'Unknown';

  const normalized = identifier.toLowerCase();
  const mapping = platformMapping[normalized];
  if (mapping) return mapping.platform;

  if (normalized.length === 42) {
    return `Unknown (${normalized.slice(0, 6)}...${normalized.slice(-4)})`;
  }

  return `Unknown (${normalized.slice(0, 8)}...${normalized.slice(-6)})`;
}

const legacyEscrowAbi = [
  'event IntentSignaled(bytes32 indexed intentHash, uint256 indexed depositId, address indexed verifier, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)',
  'event IntentFulfilled(bytes32 indexed intentHash, uint256 indexed depositId, address indexed verifier, address owner, address to, uint256 amount, uint256 sustainabilityFee, uint256 verifierFee)',
  'event IntentPruned(bytes32 indexed intentHash, uint256 indexed depositId)',
  'event DepositReceived(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, tuple(uint256,uint256) intentAmountRange)',
  'event DepositCurrencyAdded(uint256 indexed depositId, address indexed verifier, bytes32 indexed currency, uint256 conversionRate)',
  'event DepositVerifierAdded(uint256 indexed depositId, address indexed verifier, bytes32 indexed payeeDetailsHash, address intentGatingService)',
  'event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount)',
  'event DepositClosed(uint256 depositId, address depositor)',
  'event DepositCurrencyRateUpdated(uint256 indexed depositId, address indexed verifier, bytes32 indexed currency, uint256 conversionRate)',
  'event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event DepositConversionRateUpdated(uint256 indexed depositId, address indexed verifier, bytes32 indexed currency, uint256 newConversionRate)'
];

const orchestratorAbi = [
  'event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)',
  'event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease)',
  'event IntentPruned(bytes32 indexed intentHash)'
];

const escrowAbi = [
  'event DepositReceived(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, tuple(uint256,uint256) intentAmountRange, address delegate, address intentGuardian)',
  'event DepositCurrencyAdded(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 minConversionRate)',
  'event DepositPaymentMethodAdded(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed payeeDetails, address intentGatingService)'
];

const escrowV2Abi = [
  ...escrowAbi,
  'event DepositMinConversionRateUpdated(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 newMinConversionRate)',
  'event DepositFundsAdded(uint256 indexed depositId, address indexed depositor, uint256 amount)',
  'event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount)',
  'event DepositClosed(uint256 depositId, address depositor)',
  'event DepositOracleRateConfigSet(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currencyCode, address adapter, bytes adapterConfig, int16 spreadBps, uint32 maxStaleness)'
];

const modernOrchestratorAbi = [
  ...orchestratorAbi,
  'event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee)',
  'event IntentReferralFeeDistributed(bytes32 indexed intentHash, address indexed feeRecipient, uint256 feeAmount)',
  'event IntentLifecycleHookSnapshotted(bytes32 indexed intentHash, address indexed lifecycleHook)'
];

module.exports = {
  ACTIVE_PAYMENT_METHODS,
  CONTRACT_ADDRESSES,
  HISTORICAL_PAYMENT_METHODS,
  LEGACY_VERIFIERS,
  SUPPORTED_SNIPER_PLATFORMS,
  escrowAbi,
  escrowV2Abi,
  getPlatformName,
  legacyEscrowAbi,
  modernOrchestratorAbi,
  orchestratorAbi,
  platformMapping
};
