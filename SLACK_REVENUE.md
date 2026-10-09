# Peer Revenue Slack bot

An independent worker for fulfilled Base trades from Peer Web, iOS and Android.
It shares the Telegram tracker's payment-method labels, but does not run the
Telegram client or require Telegram, Supabase, or RPC credentials.

Each fulfillment produces a Slack table with Peer revenue, gross fulfilled USDC
volume, payment platform and client, followed by total fees, completion time,
and explorer links. Monetary amounts use integer USDC units and round half-up
to cents only for display.

## Install

1. Create a Slack app **from a manifest** at <https://api.slack.com/apps> using
   [`slack-app-manifest.json`](slack-app-manifest.json). Install it to the workspace.
2. Invite **Peer Revenue** into the destination public channel. Its bot scopes
   are `chat:write`, `channels:read`, and `channels:history`. History is used only
   to reconcile uncertain sends after a timeout or restart.
3. Store the new app's Bot User OAuth Token as `SLACK_BOT_TOKEN` in the service's
   secret environment. Do not use a user token or commit credentials.
4. Deploy a **separate service** from this repository. Select the Dockerfile
   builder with `Dockerfile.slack-revenue`, one replica, zero deployment overlap,
   an **Always** restart policy, and a persistent volume mounted at `/data`.
   Set these environment variables:

   ```text
   SLACK_BOT_TOKEN=<new app bot token>
   SLACK_REVENUE_CHANNEL_ID=<destination channel ID>
   SLACK_REVENUE_STATE_PATH=/data/peer-revenue.sqlite
   PEER_FEE_RECIPIENT=<verified Peer fee collection address>
   ```

   `ZKP2P_INDEXER_API_KEY` is optional; the public production indexer allows
   unauthenticated reads. The worker stays below its normal request limit.

Run only **one worker** per bot/channel, with no deployment overlap. Preserve
the volume across restarts. Do not change the existing Telegram service's
start command or Railway configuration.

For a host deployment, use Node 22.13 or later, `npm ci`, and `npm run start:slack`
under a supervisor configured to restart on failure. The Docker image supplies
the supported Node version. SIGTERM finishes the current poll before exiting.

First startup records the current time and sends **future fills only**. An
explicit `--since 2026-10-01T00:00:00Z` on the first startup opts into historical
delivery. Once state exists, restarts resume its original cursor; `--since`
does not reset it. Never delete the database to fix an ordinary delivery error.

## Preview and verification

Preview queries production data without Slack credentials, posts, or delivery
state. It prints Slack payloads for the first 100 matching fills in the window:

```sh
PEER_FEE_RECIPIENT=<verified-address> npm run start:slack -- \
  --preview --since 2026-10-01T00:00:00Z
npm run check
npm run check:slack
npm test
```

`--once` runs a single **live** poll and exits. `SHOKUNIN_SLACK_READ_ONLY=1`
rejects live operation but permits previews. Successful polls log their posted
count; failures exit nonzero for the supervisor and do not advance past the
failed trade. After installation, verify a new real fulfillment appears once
in Slack and matches its indexer distribution records.

## Accounting and coverage

- Volume is `Intent.releasedAmount`, not the requested amount: partial fills
  report the actual gross release. Total fees are gross minus `takerAmountNetFees`.
- Peer revenue is referral distributions to `PEER_FEE_RECIPIENT`, manager fees
  paid to that same recipient, and the remaining protocol fee. Partner referral
  and manager fees are excluded. Verify the configured recipient and protocol
  treasury ownership before activation and after a fee-recipient rotation.
- Referral distributions must reconcile exactly to the intent's total, and
  net plus all fees must not exceed gross. Missing release/net amounts or
  inconsistent data fail the poll; the bot never substitutes the requested
  amount or estimates revenue from a fee percentage.
- Only `zkp2p-web`, `zkp2p-ios`, `zkp2p-android`, and legacy `zkp2p-mobile`
  attribution are included. Legacy mobile is explicitly labeled **OS
  unattributed**. No attribution is inferred from payment method or wallet.
- Both `FULFILLED` and `MANUALLY_RELEASED` are included and labeled separately.
  Pending and cancelled intents are excluded.
- This complements a separate Pay revenue feed. Pay, unknown client tags,
  Relay-only swaps, and Hyperliquid fills are outside this worker's scope.

## Delivery behavior

The worker polls every 30 seconds and waits at least 60 seconds after a fill.
It pages by fulfillment time and ID, including ties, and records acknowledged
deliveries by channel and intent in SQLite. Its high-water mark advances only
with observed, delivered fills, so outages do not skip the intervening trades.
A five-minute replay window catches late rows behind that mark. Historical
re-indexing or attribution corrections older than that window need an explicit
backfill with separately managed state; this is not a historical ledger repairer.

A pending delivery is persisted before posting. On retry, the worker waits
at least a minute and searches this bot's Slack message metadata before
reposting. Slack 429s honor `Retry-After`. Slack has no transactional commit
shared with SQLite: message deletion or unavailable history can prevent
reconciliation, so this is not a claim of mathematically exactly-once delivery.
