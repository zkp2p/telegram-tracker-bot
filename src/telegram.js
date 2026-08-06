function createTelegramNotifier(bot, logger = console) {
  return async function sendTelegramNotification(chatId, message, options, context) {
    try {
      await bot.sendMessage(chatId, message, options);
      return true;
    } catch (error) {
      logger.error(`Failed to send ${context} to Telegram chat ${chatId}:`, error.message);
      return false;
    }
  };
}

module.exports = { createTelegramNotifier };
