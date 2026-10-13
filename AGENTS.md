# Agent instructions

This repository owns the Telegram escrow/intent tracker and notification bot.
Read `README.md`, `package.json`, and the relevant event handlers before editing.

- Use Node >=22 and the committed npm lockfile. `npm run check` validates
  syntax; `npm test` runs the repository tests.
- Keep event decoding and contract selection aligned with the actual ABI and
  target deployment. Do not infer live contract activation from a README.
- Preserve reconnect behavior, delivery deduplication, and persisted user
  subscriptions. Use mocked transports for routine tests.
- Starting the bot can connect to live RPC/Supabase and send Telegram messages.
  Live messaging, production deployment, and database changes require explicit
  authorization; they are not part of ordinary test execution.
- Never print bot tokens, credential-bearing RPC URLs, chat identifiers, or
  customer data. Keep local environment files untracked.
- Work in an isolated branch and open a focused PR. Documentation-only edits
  need reference checks and `git diff --check`, without starting the bot.
