# ZKP2P Telegram Tracker Bot

Telegram bot for tracking ZKP2P escrow and intent events on Base in real time, including the production OrchestratorV3 lifecycle.

## 🚀 Features
- **Full production lifecycle**: Monitors the legacy stack, Escrow/EscrowV2, and Orchestrator V1/V2/V3
- **Efficient real-time tracking**: Routes six contract subscriptions through one resilient WebSocket connection
- **Event notifications**: Get alerts for order creation, fulfillment, and cancellation
- **Sniper alerts**: Automated arbitrage notifications when deposits offer better exchange rates than market
- **Current payment methods**: Alipay, Cash App, Chime, Mercado Pago, Monzo, PayPal, Revolut, Venmo, Wise, and Zelle
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
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
EXCHANGE_API_KEY=your_exchange_rate_api_key
```

## 📊 Supported Events
- `DepositReceived` - New deposits created
- `DepositCurrencyAdded` - Currency options added (triggers sniper)
- `DepositVerifierAdded` - Platform verifiers added
- `IntentSignaled` - Orders created
- `IntentFulfilled` - Orders completed
- `IntentPruned` - Orders cancelled
- `DepositWithdrawn` - Deposits withdrawn (ignored)
- `DepositClosed` - Deposits closed (ignored)

Orchestrator V1, V2, and V3 share the lifecycle event signatures above. Contract addresses and active payment-method hashes are centralized in `src/contracts.js` and should be refreshed from the standalone `zkp2p-contracts` production deployment plus live registry state.

## Development

```bash
npm install
npm run check
npm test
```

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
