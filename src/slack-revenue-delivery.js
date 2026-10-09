const { setTimeout: sleep } = require('node:timers/promises');

function createSlack({ token, channel, fetchImpl = fetch, wait = sleep }) {
  async function call(method, args) {
    const posting = method === 'chat.postMessage';
    const url = new URL(`https://slack.com/api/${method}`);
    if (!posting) url.search = new URLSearchParams(args).toString();
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchImpl(url, {
        method: posting ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        ...(posting ? { body: JSON.stringify(args) } : {}),
        signal: AbortSignal.timeout(15000)
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter === null || !/^\d+$/.test(retryAfter)) throw new Error('Slack 429 omitted valid Retry-After');
        await wait(Number(retryAfter) * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`Slack ${method} HTTP ${response.status}`);
      const result = await response.json();
      if (result.ok !== true) throw new Error(`Slack ${method}: ${result.error}`);
      return result;
    }
    throw new Error(`Slack ${method} rate limit exhausted`);
  }
  return {
    async verify() {
      const auth = await call('auth.test', {});
      if (!auth.bot_id) throw new Error('SLACK_BOT_TOKEN must authenticate a bot');
      const info = await call('conversations.info', { channel });
      if (!info.channel.is_member || info.channel.is_archived) throw new Error('Slack bot must belong to an active destination channel');
      return auth.user_id;
    },
    async findDelivery(intentId, oldest, botUserId) {
      // A timed-out request may still be finishing server-side. Wait before
      // deciding that absent history means it is safe to try another send.
      await wait(60000);
      let cursor = '';
      do {
        const result = await call('conversations.history', { channel, oldest: String(oldest), limit: 100, cursor, include_all_metadata: true });
        for (const message of result.messages) {
          if (message.user === botUserId && message.metadata?.event_type === 'peer_revenue' &&
              message.metadata.event_payload?.intent_id === intentId) return message.ts;
        }
        const next = result.response_metadata?.next_cursor || '';
        if (next && next === cursor) throw new Error('Slack history cursor did not advance');
        cursor = next;
      } while (cursor);
      return null;
    },
    async post(intentId, alert) {
      const result = await call('chat.postMessage', {
        channel, ...alert,
        metadata: { event_type: 'peer_revenue', event_payload: { intent_id: intentId } }
      });
      if (typeof result.ts !== 'string') throw new Error('Slack accepted message without a timestamp');
      await wait(1100);
      return result.ts;
    }
  };
}

module.exports = { createSlack };
