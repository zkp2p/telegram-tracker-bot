const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ACTIVE_PAYMENT_METHODS } = require('./src/contracts');
const { CLIENTS, PAGE_SIZE, buildRevenueAlert, createIndexer, usdc } = require('./src/slack-revenue');
const { createSlack } = require('./src/slack-revenue-delivery');
const { openState, poll } = require('./src/slack-revenue-worker');

const PEER = `0x${'a'.repeat(40)}`;
const PARTNER = `0x${'b'.repeat(40)}`;
function intent(number = 1, overrides = {}) {
  const hash = `0x${number.toString(16).padStart(64, '0')}`;
  return {
    id: `8453_${hash}`, intentHash: hash, status: 'FULFILLED',
    attributionSource: 'zkp2p-web', fulfillTimestamp: '1000', fulfillTxHash: `0x${'c'.repeat(64)}`,
    releasedAmount: '80830000', takerAmountNetFees: '80062115',
    paymentMethodHash: ACTIVE_PAYMENT_METHODS.revolut, totalReferralFeeAmount: '767885',
    realizedManagerFeeAmount: '0', managerFeeRecipient: null, ...overrides
  };
}
function referrals(row) {
  return [
    { intentId: row.id, feeRecipient: PEER, feeAmount: '363735' },
    { intentId: row.id, feeRecipient: PARTNER, feeAmount: '404150' }
  ];
}

describe('Revenue amounts and attribution', () => {
  it('shows realized partial-fill volume and only Peer referral revenue', () => {
    const row = intent();
    const result = buildRevenueAlert(row, referrals(row), PEER);
    assert.equal(result.text, `💰 Peer revenue $0.36 · volume $80.83 USDC · Revolut · Web\nFulfilled · total fees $0.77 USDC · 1970-01-01T00:16:40.000Z\nhttps://peerlytics.xyz/explorer/intent/${row.intentHash}\nhttps://basescan.org/tx/${row.fulfillTxHash}`);
    assert.deepEqual(result.blocks[1].rows[1].map((cell) => cell.text), ['$0.36', '$80.83', 'Revolut', 'Web']);
  });
  it('adds residual protocol fees and Peer manager fees, excluding partner manager fees', () => {
    const row = intent(1, { releasedAmount: '100000000', takerAmountNetFees: '96000000', totalReferralFeeAmount: '1000000', realizedManagerFeeAmount: '2000000', managerFeeRecipient: PEER.toUpperCase().replace('0X', '0x') });
    const distributions = [{ intentId: row.id, feeRecipient: PARTNER, feeAmount: '1000000' }];
    assert.match(buildRevenueAlert(row, distributions, PEER).text, /revenue \$3.00/);
    assert.match(buildRevenueAlert({ ...row, managerFeeRecipient: PARTNER }, distributions, PEER).text, /revenue \$1.00/);
  });
  it('labels every client exactly, including genuinely unattributed legacy mobile', () => {
    for (const [source, label] of Object.entries(CLIENTS)) {
      const row = intent(1, { attributionSource: source });
      assert.equal(buildRevenueAlert(row, referrals(row), PEER).blocks[1].rows[1][3].text, label);
    }
    for (const source of ['zkp2p-pay', 'zkp2p-pay-ios', null, 'unrecognized']) {
      assert.throws(() => buildRevenueAlert(intent(1, { attributionSource: source }), [], PEER), /not attributed/);
    }
  });
  it('includes manual releases and zero-fee fills', () => {
    const row = intent(1, { status: 'MANUALLY_RELEASED', releasedAmount: '1000000', takerAmountNetFees: '1000000', totalReferralFeeAmount: null, realizedManagerFeeAmount: null });
    assert.match(buildRevenueAlert(row, [], PEER).text, /revenue \$0.00.*volume \$1.00/);
    assert.match(buildRevenueAlert(row, [], PEER).text, /Manually released/);
  });
  it('does not guess missing amounts, malformed types, or unreconciled fees', () => {
    for (const overrides of [
      { releasedAmount: null }, { takerAmountNetFees: undefined }, { releasedAmount: 80830000 },
      { takerAmountNetFees: '-1' }, { releasedAmount: '1' }, { status: 'PRUNED' },
      { fulfillTxHash: 'invalid' }, { paymentMethodHash: '<!channel>' }
    ]) {
      const row = intent(1, overrides);
      assert.throws(() => buildRevenueAlert(row, referrals(row), PEER));
    }
    const row = intent();
    assert.throws(() => buildRevenueAlert(row, [], PEER), /reconcile/);
    assert.throws(() => buildRevenueAlert(row, [...referrals(row), referrals(row)[0]], PEER), /Duplicate/);
    assert.throws(() => buildRevenueAlert(row, referrals(intent(2)), PEER), /does not belong/);
  });
  it('preserves large integer precision and rounds half-up only at display', () => {
    assert.equal(usdc(90071992547409930000n), '$90,071,992,547,409.93');
    assert.equal(usdc(4999n), '$0.00');
    assert.equal(usdc(5000n), '$0.01');
  });
});

describe('Indexer boundary', () => {
  it('uses keyset pagination and fetches every referral page', async () => {
    const calls = [];
    const indexer = createIndexer({ url: 'https://example.com/graphql', fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.query.includes('RevenueIntents')) return { ok: true, json: async () => ({ data: { Intent: [intent()] } }) };
      const rows = calls.length === 2 ? Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: String(i).padStart(3, '0') })) : [{ id: '100' }];
      return { ok: true, json: async () => ({ data: { ReferralFeeDistribution: rows } }) };
    } });
    assert.deepEqual(await indexer.intents(900, 2000, { time: 1000, id: 'previous' }), [intent()]);
    assert.deepEqual(calls[0].variables, { from: '900', before: '2000', afterTime: '1000', afterId: 'previous', sources: Object.keys(CLIENTS), limit: 100 });
    assert.equal((await indexer.referrals(intent().id)).length, 101);
    assert.equal(calls[2].variables.after, '099');
  });
  it('fails on GraphQL errors instead of treating them as no trades', async () => {
    const indexer = createIndexer({ url: 'https://example.com', fetchImpl: async () => ({ ok: true, json: async () => ({ errors: [{ message: 'invalid query' }] }) }) });
    await assert.rejects(indexer.intents(0, 2000, { time: 0, id: '' }), /GraphQL query failed/);
  });
});

describe('Durable Slack delivery', () => {
  function harness(db, rows) {
    const posts = [];
    const state = {
      db, channel: 'CTEST', peerRecipient: PEER, now: 2000,
      indexer: { intents: async (_from, _before, after) => rows.filter((row) => Number(row.fulfillTimestamp) > after.time || (Number(row.fulfillTimestamp) === after.time && row.id > after.id)).slice(0, PAGE_SIZE), referrals: async (id) => referrals(rows.find((row) => row.id === id)) },
      slack: { verify: async () => 'UBOT', findDelivery: async () => null, post: async (id) => { posts.push(id); return '2000.1'; } }
    };
    return { state, posts };
  }
  it('persists successes across restart and catches same-second fills beyond a full page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-revenue-'));
    const path = join(dir, 'state.sqlite');
    let db = openState(path, 'CTEST', 900);
    try {
      const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => intent(i + 1));
      const { state, posts } = harness(db, rows);
      assert.equal(await poll(state), 101);
      assert.equal(posts.length, 101);
      db.close();
      db = openState(path, 'CTEST', 2000);
      state.db = db;
      assert.equal(await poll(state), 0);
      assert.equal(posts.length, 101);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });
  it('recovers a Slack acceptance whose response was lost without reposting', async () => {
    const db = openState(':memory:', 'CTEST', 900);
    const { state } = harness(db, [intent()]);
    let posts = 0;
    state.slack.post = async () => { posts++; throw new Error('response lost'); };
    try {
      await assert.rejects(poll(state), /response lost/);
      assert.equal(db.prepare('SELECT highwater FROM cursor').get().highwater, 900);
      state.now += 61;
      state.slack.findDelivery = async (id, oldest, user) => {
        assert.equal(id, intent().id);
        assert.equal(oldest, 1995);
        assert.equal(user, 'UBOT');
        return '2000.5';
      };
      assert.equal(await poll(state), 0);
      assert.equal(posts, 1);
      assert.equal(db.prepare('SELECT slack_ts FROM deliveries').get().slack_ts, '2000.5');
    } finally { db.close(); }
  });
  it('retries a rejected send after checking history and never advances on bad accounting', async () => {
    const db = openState(':memory:', 'CTEST', 900);
    const { state, posts } = harness(db, [intent()]);
    const post = state.slack.post;
    try {
      state.slack.post = async () => { throw new Error('not_in_channel'); };
      await assert.rejects(poll(state), /not_in_channel/);
      state.now += 61;
      state.slack.post = post;
      assert.equal(await poll(state), 1);
      assert.equal(posts.length, 1);
      state.indexer.intents = async () => [intent(2)];
      state.indexer.referrals = async () => [];
      await assert.rejects(poll(state), /reconcile/);
      assert.equal(posts.length, 1);
    } finally { db.close(); }
  });
  it('does not skip an indexer outage or a late fill in the replay window', async () => {
    const db = openState(':memory:', 'CTEST', 900);
    const rows = [intent(1)];
    const { state, posts } = harness(db, rows);
    try {
      await poll(state);
      state.now += 86400;
      rows.push(intent(2, { fulfillTimestamp: '999' }), intent(3, { fulfillTimestamp: '3000' }));
      rows.sort((a, b) => Number(a.fulfillTimestamp) - Number(b.fulfillTimestamp));
      assert.equal(await poll(state), 2);
      assert.equal(posts.length, 3);
    } finally { db.close(); }
  });
});

describe('Slack transport', () => {
  it('verifies identity and destination through Slack GET query parameters', async () => {
    const slack = createSlack({ token: 'test', channel: 'CTEST', fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      if (url.pathname.endsWith('auth.test')) return { ok: true, json: async () => ({ ok: true, user_id: 'UBOT', bot_id: 'BBOT' }) };
      assert.equal(url.searchParams.get('channel'), 'CTEST');
      return { ok: true, json: async () => ({ ok: true, channel: { is_member: true, is_archived: false } }) };
    } });
    assert.equal(await slack.verify(), 'UBOT');
  });
  it('honors Retry-After and requires Slack acknowledgment', async () => {
    const waits = [];
    let calls = 0;
    const slack = createSlack({ token: 'test', channel: 'CTEST', wait: async (ms) => waits.push(ms), fetchImpl: async (_, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test');
      assert.equal(JSON.parse(options.body).metadata.event_payload.intent_id, intent().id);
      return ++calls === 1 ? { status: 429, headers: new Headers({ 'retry-after': '2' }) } : { ok: true, json: async () => ({ ok: true, ts: '2000.1' }) };
    } });
    assert.equal(await slack.post(intent().id, { text: 'test' }), '2000.1');
    assert.deepEqual(waits, [2000, 1100]);
  });
  it('paginates history and only recognizes this bot and exact intent', async () => {
    let calls = 0;
    const waits = [];
    const slack = createSlack({ token: 'test', channel: 'CTEST', wait: async (ms) => waits.push(ms), fetchImpl: async () => ({ ok: true, json: async () => ++calls === 1
      ? { ok: true, messages: [{ user: 'OTHER', ts: '1', metadata: { event_type: 'peer_revenue', event_payload: { intent_id: intent().id } } }], response_metadata: { next_cursor: 'page2' } }
      : { ok: true, messages: [{ user: 'UBOT', ts: '2', metadata: { event_type: 'peer_revenue', event_payload: { intent_id: intent().id } } }] } }) });
    assert.equal(await slack.findDelivery(intent().id, 0, 'UBOT'), '2');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [60000]);
  });
});
