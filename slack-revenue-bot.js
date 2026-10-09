require('dotenv').config();
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { ADDRESS, buildRevenueAlert, createIndexer } = require('./src/slack-revenue');
const { createSlack } = require('./src/slack-revenue-delivery');
const { openState, poll } = require('./src/slack-revenue-worker');

async function main() {
  const { values } = parseArgs({ options: { preview: { type: 'boolean' }, since: { type: 'string' }, once: { type: 'boolean' } } });
  const peerRecipient = process.env.PEER_FEE_RECIPIENT;
  if (!ADDRESS.test(peerRecipient)) throw new Error('PEER_FEE_RECIPIENT must be the verified Peer fee collection address');
  const indexer = createIndexer({ url: 'https://indexer.zkp2p.xyz/v1/graphql', apiKey: process.env.ZKP2P_INDEXER_API_KEY });
  const now = Math.floor(Date.now() / 1000);
  const start = values.since === undefined ? now : Date.parse(values.since) / 1000;
  if (!Number.isSafeInteger(start) || start < 0 || start > now) throw new Error('--since must be an ISO timestamp at or before now');
  if (values.preview) {
    if (values.since === undefined) throw new Error('--preview requires --since');
    const rows = await indexer.intents(start, now - 60, { time: start, id: '' });
    for (const row of rows) console.log(JSON.stringify(buildRevenueAlert(row, await indexer.referrals(row.id), peerRecipient)));
    return;
  }
  if (process.env.SHOKUNIN_SLACK_READ_ONLY === '1') throw new Error('Slack writes disabled by SHOKUNIN_SLACK_READ_ONLY');
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_REVENUE_CHANNEL_ID;
  const path = process.env.SLACK_REVENUE_STATE_PATH;
  if (!token || !/^C[A-Z0-9]+$/.test(channel) || !path) throw new Error('Set SLACK_BOT_TOKEN, SLACK_REVENUE_CHANNEL_ID and a persistent SLACK_REVENUE_STATE_PATH');
  const slack = createSlack({ token, channel });
  await slack.verify();
  mkdirSync(dirname(path), { recursive: true });
  const db = openState(path, channel, start);
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    do {
      const posted = await poll({ db, channel, indexer, slack, peerRecipient });
      console.log(JSON.stringify({ event: 'revenue_poll_completed', posted }));
      if (values.once || stopping) break;
      await sleep(30000);
    } while (!stopping);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Revenue worker failed');
  process.exitCode = 1;
});
