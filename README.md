# ZKP2P Telegram Tracker Bot

Telegram bot for tracking ZKP2P escrow and intent events on Base in real time, including the production OrchestratorV4 lifecycle.

## 🚀 Features
- **Full production lifecycle**: Monitors the legacy stack, Escrow/EscrowV2, and Orchestrator V1/V2/V3/V4
- **Efficient real-time tracking**: Routes seven contract subscriptions through one resilient WebSocket connection
- **Event notifications**: Get buy-order alerts for intents and sell-order alerts for new deposits
- **Sniper alerts**: Automated arbitrage notifications when deposits offer better exchange rates than market
- **Current payment methods**: Alipay, Cash App, Chime, Mercado Pago, Monobank, Monzo, PayPal, Revolut, Venmo, Wise, X Money, and Zelle
- **Persistent storage**: User data backed by Supabase database
- **Resilient operation**: Automatic reconnects, graceful shutdown, and isolated event-handler failures

## 📱 Commands

### Deposit Tracking
- `/deposit 123` - Track a specific deposit
- `/deposit all` - Listen to ALL deposits (every event)
- `/deposit stop` - Stop listening to all deposits
- `/deposit 123,456,789` - Track multiple deposits
- `/remove 123` - Stop tracking specific deposit(s)

### Sniper (Arbitrage Alerts)
- `/sniper eur` - Snipe EUR on ALL platforms
- `/sniper eur revolut` - Snipe EUR only on Revolut
- `/sniper uah monobank` - Snipe Ukrainian hryvnia only on Monobank
- `/sniper usd zelle` - Snipe USD only on Zelle
- `/sniper list` - Show active sniper settings
- `/sniper clear` - Clear all sniper settings
- `/unsnipe eur` - Stop sniping EUR (all platforms)
- `/unsnipe eur wise` - Stop sniping EUR on Wise only

### General
- `/list` - Show all tracking status (deposits + snipers)
- `/clearall` - Stop all tracking and clear everything
- `/status` - Check WebSocket connection and settings
- `/help` - Show this help message

## 🎯 How Sniper Works
The bot monitors exchange rates and alerts you when new deposits offer better rates than market:
- Compares deposit rates vs live market rates
- Alerts on opportunities 0.2% or better
- Supports currency and platform-specific targeting
- Shows exact percentage discount and profit potential

## 🛠 Setup

### Environment Variables
```bash
TELEGRAM_BOT_TOKEN=your_bot_token
BASE_RPC=wss://your_base_websocket_rpc
SUPABASE_URL=https://your_project.supabase.co
SUPABASE_ANON_KEY=your_supabase_key
DISCORD_ORDERS_WEBHOOK_URL=https://discord.com/api/webhooks/your_orders_id/your_orders_token
DISCORD_SNIPER_WEBHOOK_URL=https://discord.com/api/webhooks/your_sniper_id/your_sniper_token
```

In production these values live in Infisical project `telegram-tracker`
(`11d609d9-755e-4ce1-96aa-e66a8bc8eb05`), env `prod`; config CD deploys them (see
[Deploy](#deploy)). For local runs, put them in a git-ignored `.env`, which
`bot.js` loads with `dotenv`.

All six values above are required; `NODE_ENV` and `CURATOR_API_URL` are optional.
Market rates (USD FX table and the ARS crypto-dollar quote) are read from Curator
at `CURATOR_API_URL`, an HTTPS URL that defaults to `https://api.zkp2p.xyz`; the
bot holds no exchange-rate API key. Startup validates
configuration before creating clients and exits 1 with one stderr line naming bad
keys as missing or invalid, never their values, so a bad config deploy fails the
30-second health check and rolls back. Supabase and Discord URLs require HTTPS;
`BASE_RPC` accepts `ws:`, `wss:`, `http:` or `https:` without fragments, but the
endpoint must support WebSocket connections. It is the only RPC setting: event
subscriptions use it as given, and block and oracle reads use its HTTP form
(`wss:` becomes `https:`), so it must be a paid provider endpoint that serves
both. The bot never calls a public RPC.

## 📊 Supported Events
- `DepositReceived` - New sell orders created; batched with payment-method events for one complete alert
- `DepositCurrencyAdded` - Currency options added (triggers sniper)
- `DepositVerifierAdded` - Platform verifiers added
- `IntentSignaled` - Buy orders created
- `IntentFulfilled` - Buy orders completed
- `IntentPruned` - Buy orders cancelled
- `DepositWithdrawn` - Deposits withdrawn (ignored)
- `DepositClosed` - Deposits closed (ignored)

Orchestrator V1, V2, and V3 share the lifecycle event signatures above; V4 adds `groupId` and `arbitrator` to `IntentSignaled` and reports `releasedBy` in `IntentFulfilled`. Contract addresses and active payment-method hashes are centralized in `src/contracts.js` and should be refreshed from the standalone `zkp2p-contracts` production deployment plus live registry state.

## Development

```bash
npm install
npm run check
npm test
```

## Deploy

Production runs on AWS EC2 through the Peer Deploy platform; details are in
[`deploy/AWS.md`](deploy/AWS.md).

- **Branch:** push or fast-forward `releases/prod`, or dispatch **Deploy** on it
  to redeploy. `.github/workflows/deploy.yml` builds `deploy/Dockerfile` and
  deploys it over SSM with peer-deploy's stop-then-start `restart` strategy.
  Deploys never happen by hand on the host.
- **CI gate:** a successful `ci.yml` run for the commit is required.
- **Config:** Infisical project `telegram-tracker`, env `prod`, is the source of
  truth. Config CD snapshots it to Secrets Manager `peer/telegram-tracker/prod`
  and runs `Deploy releases/prod (reconcile)` automatically.
- **Rollback:** move `releases/prod` to the last known-good commit; revert
  config in Infisical. Check for alerts missed while the bot was stopped.
- **Logs:** deploy output in CloudWatch `/peer/deploy/telegram-tracker`;
  application output via `docker logs peer-telegram-tracker` in an SSM session.

## 🤝 Contributing
This is an **open source** project! Contributions welcome:
1. Fork the repo
2. Create a feature branch
3. Submit a pull request

**Ideas for contributions:**
- Additional exchange rate providers
- More sophisticated arbitrage calculations
- Portfolio tracking features
- Advanced filtering options

## 📄 License
MIT License - feel free to use and modify!

---
*Built for the ZKP2P community. Trade safely and happy sniping! 🎯*
