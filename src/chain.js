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

module.exports = { resolveBlockTimestamp };
