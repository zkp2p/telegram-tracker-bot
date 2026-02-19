# ZKP2P Telegram Tracker Bot
Telegram bot for tracking ZKP2P deposit events on Base blockchain in real-time with advanced sniper alerts for arbitrage opportunities.

## 🚀 Features
- **Real-time tracking**: Monitor specific deposit IDs or listen to all deposits
- **Event notifications**: Get alerts for order creation, fulfillment, and cancellation
- **Sniper alerts**: Automated arbitrage notifications when deposits offer better exchange rates than market
- **Multi-platform support**: CashApp, Venmo, Revolut, Wise, and Zelle
- **Persistent storage**: User data backed by Supabase database
- **Clean event handling**: Ignores withdrawal events to prevent spam

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
BASE_RPC=your_base_rpc_url  
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
EXCHANGE_API_KEY=your_exchange_rate_api_key

# Observability (OpenTelemetry -> Better Stack)
BETTERSTACK_SOURCE_TOKEN=your_betterstack_source_token
OTEL_SERVICE_NAME=telegram-tracker-bot
DEPLOYMENT_ENVIRONMENT=production
```

### Observability
- Tracing is preloaded automatically at startup (`node -r ./telemetry/register.js bot.js`)
- Pino logs include `trace_id` + `span_id` from active OTel context
- Full setup and ops runbook: [`docs/observability.md`](docs/observability.md)

## 📊 Supported Events
- `DepositReceived` - New deposits created
- `DepositCurrencyAdded` - Currency options added (triggers sniper)
- `DepositVerifierAdded` - Platform verifiers added
- `IntentSignaled` - Orders created
- `IntentFulfilled` - Orders completed
- `IntentPruned` - Orders cancelled
- `DepositWithdrawn` - Deposits withdrawn (ignored)
- `DepositClosed` - Deposits closed (ignored)

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
