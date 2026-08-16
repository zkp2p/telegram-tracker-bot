function createDepositCreationCollector({
  onComplete,
  schedule = (callback) => setTimeout(callback, 10000),
  logger = console
}) {
  if (typeof onComplete !== 'function') {
    throw new Error('Deposit creation collector requires an onComplete callback');
  }

  const pending = new Map();

  function key(log, escrowAddress, depositId) {
    return `${log.transactionHash.toLowerCase()}-${escrowAddress.toLowerCase()}-${depositId}`;
  }

  function recordReceived(log, escrowAddress, depositId, amount) {
    const creationKey = key(log, escrowAddress, depositId);
    pending.set(creationKey, {
      depositId,
      escrowAddress,
      amount,
      platforms: new Set(),
      blockNumber: log.blockNumber
    });

    schedule(async () => {
      const creation = pending.get(creationKey);
      if (!creation) return;
      pending.delete(creationKey);

      try {
        await onComplete({ ...creation, platforms: [...creation.platforms] });
      } catch (error) {
        logger.error(`Failed to process deposit creation ${creationKey}:`, error);
      }
    });
  }

  function recordPlatform(log, escrowAddress, depositId, platform) {
    const creation = pending.get(key(log, escrowAddress, depositId));
    if (creation) creation.platforms.add(platform);
  }

  return { recordPlatform, recordReceived };
}

module.exports = { createDepositCreationCollector };
