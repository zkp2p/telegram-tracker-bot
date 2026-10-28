# Telegram tracker on AWS

## Continuous deployment

Push to `releases/prod` to deploy through the Peer Deploy Platform. The Deploy
workflow also supports `workflow_dispatch` on that branch, with no inputs and
image mode only. Deploys are serialized per branch and never cancel a running
deployment; key removal is disabled.

GitHub-hosted `ubuntu-latest` runners build `deploy/Dockerfile`, which runs
`npm ci`, `npm run check`, `npm test` and production dependency pruning. CI also
runs the Python health-lookup tests. The public build workflow uploads the
immutable `telegram-tracker-image` artifact through GitHub OIDC using
`peer-deploy-artifacts-telegram-tracker`. The deploy workflow requires successful
CI for the source SHA, resolves `deploy/environments.yml`, and assumes
`peer-deploy-telegram-tracker-prod` through OIDC. SSM document
`peer-deploy-telegram-tracker-prod` deploys the image; command logs go to
`/peer/deploy/telegram-tracker`, and GitHub records deployment status. Both
reusable workflows are pinned in `.github/workflows/deploy.yml`. Workflows
require no repository secrets or runner variables.

## Restart and rollback

The tracker uses a restart strategy: stop the current poller before starting its
replacement. Only one poller may run at a time, with no overlap and an expected
gap of a few seconds. There is no inbound application health endpoint.

Roll back by moving `releases/prod` back to the known-good commit through the
same deployment pipeline. Host configuration and runtime credentials remain
host-managed. After release or rollback, verify service and dependency health
and actual Telegram alert delivery. Reconcile contract logs across the stopped
interval: the tracker has no durable block cursor, so startup health alone does
not prove that no alerts were missed.

## Host configuration

Host configuration lives in `zkp2p/peer-infra` under `hosts/telegram-tracker`,
including the `peer-telegram-tracker` service and container restrictions. The
image uses Node 22.23.4 and `USER 10001:10001`, with command
`["node", "/opt/peer/runtime.cjs", "bot.js"]`.

Runtime JSON stays host-managed at `/etc/peer-telegram-tracker/runtime.json`,
mounted read-only at `/run/secrets/runtime.json`. It is not stored in this repo
or embedded in the image. The runtime wrapper loads it and redacts configured
credential values from the child process output.

## Health monitor and verification

`aws-health.py` checks the service, image, Telegram, Supabase, Base RPC and disk,
and emits CloudWatch metrics using the EC2 instance role. It reads owner-only
`/etc/peer-telegram-tracker/health-target.json` with `region`, `accountId`,
`instanceId` and `roleName`. The expected image comes from
`/var/lib/peer-rollouts/telegram-tracker-prod/current.json` (`image`), falling
back to `/var/lib/peer-telegram-tracker-migration/build.json` (`app.id`) only
when the current rollout file is missing. Invalid metadata fails the image
check closed.

The monitor runs on the host, outside the image. Whenever `deploy/aws-health.py`
changes, an operator must install the reviewed script at
`/opt/peer-telegram-tracker/aws-health.py`; image deployment does not update it.

Local verification (Python 3.9 or later and Node from `.nvmrc`):

```sh
actionlint
python3 -m unittest discover -s deploy -v
docker build -f deploy/Dockerfile .
npm run check && npm test
```
