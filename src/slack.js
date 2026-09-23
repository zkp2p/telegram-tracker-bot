function createSlackNotifier({ token, channel, fetchImpl = fetch, logger = console }) {
  if (!token || !channel) {
    throw new Error('Slack fee alerts require SLACK_BOT_TOKEN and SLACK_FEES_CHANNEL_ID');
  }

  return async function sendSlackNotification(message, intentUrl) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: JSON.stringify({
            channel,
            text: `${message}\n<${intentUrl}|View on Peerlytics>`,
            unfurl_links: false,
            unfurl_media: false
          })
        });
        if (response.status === 429 && attempt < 2) {
          const retryAfter = Number(response.headers.get('retry-after'));
          if (!Number.isFinite(retryAfter) || retryAfter < 0) {
            throw new Error('Slack fee alert rate limit omitted Retry-After');
          }
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(`Slack fee alert failed: ${result.error || response.status}`);
        }
        return true;
      }
    } catch (error) {
      logger.error('Failed to send fulfilled order to Slack:', error);
      return false;
    }
  };
}

module.exports = { createSlackNotifier };
