const { getPlatformName } = require('./contracts');
const { formatPlatform, peerlyticsIntentUrl } = require('./alerts');

const CLIENTS = Object.freeze({
  'zkp2p-web': 'Web',
  'zkp2p-ios': 'iOS',
  'zkp2p-android': 'Android',
  'zkp2p-mobile': 'Mobile (OS unattributed)'
});
const PAGE_SIZE = 100;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function unsigned(value, field) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Indexer ${field} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function usdc(micro) {
  const cents = (micro + 5000n) / 10000n;
  return `$${(cents / 100n).toLocaleString('en-US')}.${String(cents % 100n).padStart(2, '0')}`;
}

function buildRevenueAlert(row, distributions, peerRecipient) {
  if (!Object.hasOwn(CLIENTS, row.attributionSource)) {
    throw new Error('Intent is not attributed to a Peer web or mobile client');
  }
  if (!['FULFILLED', 'MANUALLY_RELEASED'].includes(row.status) ||
      !HASH.test(row.intentHash) || row.id !== `8453_${row.intentHash}` ||
      !HASH.test(row.fulfillTxHash) || !ADDRESS.test(peerRecipient) ||
      (row.paymentMethodHash !== null && !HASH.test(row.paymentMethodHash))) {
    throw new Error('Invalid Base fulfillment or Peer fee recipient');
  }
  const timestamp = unsigned(row.fulfillTimestamp, 'fulfillTimestamp');
  const gross = unsigned(row.releasedAmount, 'releasedAmount');
  const net = unsigned(row.takerAmountNetFees, 'takerAmountNetFees');
  // Null means the corresponding fee event was never emitted, per Intent schema.
  const referral = row.totalReferralFeeAmount === null ? 0n : unsigned(row.totalReferralFeeAmount, 'totalReferralFeeAmount');
  const manager = row.realizedManagerFeeAmount === null ? 0n : unsigned(row.realizedManagerFeeAmount, 'realizedManagerFeeAmount');
  let distributed = 0n;
  let peerReferral = 0n;
  const recipients = new Set();
  for (const distribution of distributions) {
    if (distribution.intentId !== row.id || !ADDRESS.test(distribution.feeRecipient)) {
      throw new Error('Referral distribution does not belong to the fulfillment');
    }
    const recipient = distribution.feeRecipient.toLowerCase();
    if (recipients.has(recipient)) throw new Error('Duplicate referral fee recipient');
    recipients.add(recipient);
    const amount = unsigned(distribution.feeAmount, 'feeAmount');
    distributed += amount;
    if (recipient === peerRecipient.toLowerCase()) peerReferral += amount;
  }
  if (distributed !== referral || net + referral + manager > gross) {
    throw new Error('Fulfillment fee amounts do not reconcile');
  }
  if (manager > 0n && !ADDRESS.test(row.managerFeeRecipient)) {
    throw new Error('Realized manager fee has no valid recipient');
  }
  const fees = gross - net;
  const protocol = fees - referral - manager;
  const peerManager = manager > 0n && row.managerFeeRecipient.toLowerCase() === peerRecipient.toLowerCase() ? manager : 0n;
  const revenue = protocol + peerReferral + peerManager;
  const platformName = getPlatformName(row.paymentMethodHash);
  const platform = platformName.startsWith('Unknown') ? platformName : formatPlatform(platformName);
  const client = CLIENTS[row.attributionSource];
  const status = row.status === 'MANUALLY_RELEASED' ? 'Manually released' : 'Fulfilled';
  const intentUrl = peerlyticsIntentUrl(row.intentHash);
  const txUrl = `https://basescan.org/tx/${row.fulfillTxHash}`;
  const time = new Date(Number(timestamp) * 1000).toISOString();
  const text = `💰 Peer revenue ${usdc(revenue)} · volume ${usdc(gross)} USDC · ${platform} · ${client}\n${status} · total fees ${usdc(fees)} USDC · ${time}\n${intentUrl}\n${txUrl}`;
  const cell = (text) => ({ type: 'raw_text', text });
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: `💰 ${status} on Peer` } },
      { type: 'table', rows: [
        ['Peer revenue (USDC)', 'Volume (USDC)', 'Platform', 'Client'].map(cell),
        [usdc(revenue), usdc(gross), platform, client].map(cell)
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Total fees: ${usdc(fees)} USDC · ${time}\n<${intentUrl}|Intent> · <${txUrl}|Transaction>` }] }
    ],
    unfurl_links: false,
    unfurl_media: false
  };
}

function createIndexer({ url, apiKey = '', fetchImpl = fetch }) {
  async function query(query, variables) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Indexer HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length || !result.data) throw new Error('Indexer GraphQL query failed');
    return result.data;
  }
  return {
    async intents(from, before, after) {
      const data = await query(`query RevenueIntents($from: numeric!, $before: numeric!, $afterTime: numeric!, $afterId: String!, $sources: [String!]!, $limit: Int!) {
        Intent(where: {_and: [
          {id: {_like: "8453_%"}},
          {status: {_in: [FULFILLED, MANUALLY_RELEASED]}},
          {attributionSource: {_in: $sources}},
          {fulfillTimestamp: {_gte: $from, _lt: $before}},
          {_or: [{fulfillTimestamp: {_gt: $afterTime}}, {fulfillTimestamp: {_eq: $afterTime}, id: {_gt: $afterId}}]}
        ]}, order_by: [{fulfillTimestamp: asc}, {id: asc}], limit: $limit) {
          id intentHash status attributionSource fulfillTimestamp fulfillTxHash
          releasedAmount takerAmountNetFees paymentMethodHash totalReferralFeeAmount
          realizedManagerFeeAmount managerFeeRecipient
        }
      }`, { from: String(from), before: String(before), afterTime: String(after.time), afterId: after.id, sources: Object.keys(CLIENTS), limit: PAGE_SIZE });
      if (!Array.isArray(data.Intent)) throw new Error('Indexer returned no Intent array');
      return data.Intent;
    },
    async referrals(intentId) {
      const rows = [];
      let after = '';
      for (;;) {
        const data = await query(`query RevenueReferrals($intentId: String!, $after: String!, $limit: Int!) {
          ReferralFeeDistribution(where: {intentId: {_eq: $intentId}, id: {_gt: $after}}, order_by: {id: asc}, limit: $limit) {
            id intentId feeRecipient feeAmount
          }
        }`, { intentId, after, limit: PAGE_SIZE });
        if (!Array.isArray(data.ReferralFeeDistribution)) throw new Error('Indexer returned no referral array');
        for (const row of data.ReferralFeeDistribution) {
          if (typeof row.id !== 'string' || row.id <= after) throw new Error('Referral cursor did not advance');
          after = row.id;
          rows.push(row);
        }
        if (data.ReferralFeeDistribution.length < PAGE_SIZE) return rows;
      }
    }
  };
}

module.exports = { ADDRESS, CLIENTS, PAGE_SIZE, buildRevenueAlert, createIndexer, unsigned, usdc };
