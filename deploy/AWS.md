# Production AWS operation

Production moved from Railway to AWS on 2026-10-22 using application source
`ae0ad63e3fddb915778818fa2f978232b2d58f4a`. This directory packages that source;
it does not change trading alerts or subscription logic.

## Runtime

- Account `411399509833`, region `us-east-1`, instance `i-0da4a896fd49398b5`.
- Systemd unit and Docker container: `peer-telegram-tracker`.
- Image: `sha256:a89bdcba8e47fcb8ff093dd9b23e61858336bed6825524dea8f8f757deb80393`.
- Node 22.23.4, UID 10001, read-only root, dropped capabilities, 512 MiB memory.
- Host configuration: `/etc/peer-telegram-tracker/runtime.json`, mode 0400,
  mounted at `/run/secrets/runtime.json`. Never print it or put it in an image.
- The wrapper redacts configured credential values from both child output streams.
- There is no inbound application endpoint, local database, or Redis.

Canonical incident runtime references are in Infisical project `zkp2p-tg-bot`,
production, under the `AWS_TRACKER_` prefix. Strip that prefix when rendering
the seven application variables. These entries captured existing credentials;
their creation is **not** credential rotation. Unprefixed entries belong to a
different valid Telegram bot and must not be substituted without resolving ownership.

## Single-consumer release and recovery

1. Verify the AWS account, instance, current image, bot identity and source commit.
2. Run `npm run check` and `npm test`; build the Dockerfile and verify dependencies
   without starting another polling consumer.
3. Retain a verified image archive and current protected configuration. Stop the
   current consumer before activating a replacement. Never run Railway and AWS
   polling simultaneously.
4. Start the intended image through the service unit. Verify the expected bot
   (`peer_server_bot`, ID `8665567460`), all six Base subscriptions, database access,
   RPC chain, redacted logs and an actual Telegram notification.
5. Reconcile contract logs across the stopped interval. This application has no
   durable block cursor; a clean startup alone does not prove no missed alerts.
6. On failure, stop the replacement and restore the verified prior AWS image with
   current credentials. Do not revive exposed credentials or Railway automatically.

The initial cutover observed zero monitored contract logs in blocks
52952336–52952343. Real Telegram notifications were observed after activation.
The old Railway deployment is removed, autodeploy disabled and restart policy NEVER.

The image is archived in the versioned service backup bucket under
`telegram-tracker/artifacts/8ff871618b92bf2f484fa9ba43af66b8ff9a254d72a93d8a072da27b1b947850.tar.gz`,
version `AP.v81Ky7gqou8gSo7WCgOp5CSeklb2O`; exact-version download, SHA-256 and
Docker load were verified. Root snapshots are daily and encrypted. They do not
back up the externally hosted Supabase database.

## Monitoring and unresolved access

`aws-health.py` emits process, image, Telegram, Supabase, RPC and disk checks using
the scoped EC2 role. Six CloudWatch alarms exist. The shared SNS topic currently
has no confirmed subscription, so notification delivery is not verified.

Credential rotation remains open pending provider ownership: Telegram BotFather,
Supabase administration, Alchemy, exchange-rate provider and Discord. The current
Supabase anon role can read application tables; close that access after installing
a scoped backend identity and verifying the consumer. Both existing Discord
webhooks already return 404/Unknown Webhook and require replacement or retirement.
Do not describe those existing failures as a verified revocation by this migration.
