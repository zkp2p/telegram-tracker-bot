async function resolveBlockTimestamp(
  provider,
  blockNumber,
  {
    fallbackTimestamp = Math.floor(Date.now() / 1000),
    logger = console
  } = {}
) {
  try {
    const block = await provider.getBlock(blockNumber);
    const timestamp = Number(block?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error(`Block ${blockNumber} did not include a valid timestamp`);
    }
    return timestamp;
  } catch (error) {
    logger.warn(`Failed to resolve timestamp for block ${blockNumber}; using current time:`, error.message);
    return fallbackTimestamp;
  }
}

/** HTTP form of the configured RPC endpoint; the provider serves both transports on one URL. */
function toHttpRpcUrl(rpcUrl) {
  return rpcUrl.trim().replace(/^ws(s?):\/\//i, (_scheme, secure) => `http${secure.toLowerCase()}://`);
}

module.exports = { resolveBlockTimestamp, toHttpRpcUrl };
