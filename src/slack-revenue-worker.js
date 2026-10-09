const { DatabaseSync } = require('node:sqlite');
const { PAGE_SIZE, buildRevenueAlert, unsigned } = require('./slack-revenue');

function openState(path, channel, start) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS cursor (channel TEXT PRIMARY KEY, started INTEGER NOT NULL, highwater INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (channel TEXT NOT NULL, intent_id TEXT NOT NULL, attempted INTEGER NOT NULL, slack_ts TEXT, PRIMARY KEY (channel, intent_id));`);
  db.prepare('INSERT OR IGNORE INTO cursor VALUES (?, ?, ?)').run(channel, start, start);
  return db;
}

async function poll({ db, channel, indexer, slack, peerRecipient, now = Math.floor(Date.now() / 1000) }) {
  const botUserId = await slack.verify();
  const checkpoint = db.prepare('SELECT started, highwater FROM cursor WHERE channel = ?').get(channel);
  // Keep the cursor tied to indexed events, not wall time: an indexer outage
  // must not advance it past unseen fills. Replay five minutes for late rows.
  const from = Math.max(checkpoint.started, checkpoint.highwater - 300);
  let after = { time: from, id: '' };
  let posted = 0;
  for (;;) {
    const rows = await indexer.intents(from, now - 60, after);
    for (const row of rows) {
      const time = Number(unsigned(row.fulfillTimestamp, 'fulfillTimestamp'));
      if (time < after.time || (time === after.time && row.id <= after.id)) throw new Error('Intent cursor did not advance');
      const delivery = db.prepare('SELECT attempted, slack_ts FROM deliveries WHERE channel = ? AND intent_id = ?').get(channel, row.id);
      if (!delivery?.slack_ts) {
        const alert = buildRevenueAlert(row, await indexer.referrals(row.id), peerRecipient);
        let slackTs = null;
        if (delivery) {
          slackTs = await slack.findDelivery(row.id, delivery.attempted - 5, botUserId);
        }
        if (slackTs === null) {
          db.prepare('INSERT INTO deliveries VALUES (?, ?, ?, NULL) ON CONFLICT(channel, intent_id) DO UPDATE SET attempted = excluded.attempted').run(channel, row.id, now);
          slackTs = await slack.post(row.id, alert);
          posted++;
        }
        db.prepare('UPDATE deliveries SET slack_ts = ? WHERE channel = ? AND intent_id = ?').run(slackTs, channel, row.id);
      }
      db.prepare('UPDATE cursor SET highwater = MAX(highwater, ?) WHERE channel = ?').run(time, channel);
      after = { time, id: row.id };
    }
    if (rows.length < PAGE_SIZE) return posted;
  }
}

module.exports = { openState, poll };
