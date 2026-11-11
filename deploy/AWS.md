# Telegram tracker on AWS

## Continuous deployment

Push to `releases/prod` to deploy through the Peer Deploy Platform. The Deploy
workflow also supports `workflow_dispatch` on that branch. Deploys are serialized
per branch and never cancel a running deployment; key removal is disabled.
Every deploy goes through this workflow: anyone authorized may push the branch
or dispatch it, but nobody starts or replaces the bot by hand on the host or
edits the host's deploy tooling. Operator access to the host is AWS Systems
Manager only.

A manual **Deploy** dispatch on `releases/prod` redeploys in `image` mode with
`reason` `manual`. `peer-config-reconciler` (peer-infra `stacks/config-cd`)
dispatches `mode=image` with `reason=reconcile`; those runs are named
`Deploy releases/prod (reconcile)`.

This is a public repository, so every job runs on GitHub-hosted runners. The
image is built by `zkp2p/.github` `build-deploy-image-public.yml` on a fixed
`ubuntu-24.04` runner; CI and the deploy job use `ubuntu-latest`. The build runs
`deploy/Dockerfile`: `npm ci`, `npm run check`, `npm test` and production
dependency pruning. CI also runs the Python health-lookup tests. The public
build workflow uploads the
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

Roll back code by moving `releases/prod` back to the known-good commit through
the same deployment pipeline (`--force-with-lease` when moving backward). Roll
back config by reverting the value in Infisical; config CD redeploys it. To stop
config CD from deploying further Infisical changes, set target
`telegram-tracker/prod` to `observe` per peer-infra
`stacks/config-cd/RUNBOOK.md` ("Pause a target"). A failed health check during a
deploy restores the previous container automatically.

After release or rollback, verify service and dependency health
and actual Telegram alert delivery. Reconcile contract logs across the stopped
interval: the tracker has no durable block cursor, so startup health alone does
not prove that no alerts were missed.

## Host configuration

Host configuration lives in `zkp2p/peer-infra` under `hosts/telegram-tracker`,
including the `peer-telegram-tracker` service and container restrictions. The
image uses Node 22.23.4 and `USER 10001:10001`, with command
`["node", "/opt/peer/runtime.cjs", "bot.js"]`.

## Configuration

Infisical is the source of truth: project `telegram-tracker`
(`11d609d9-755e-4ce1-96aa-e66a8bc8eb05`), env `prod`, path `/`. Its webhook marks
config-CD target `telegram-tracker/prod`; the reconciler publishes the Secrets
Manager snapshot `peer/telegram-tracker/prod` and dispatches a
`Deploy releases/prod (reconcile)` run. Each image deploy writes the snapshot to
a per-attempt file under `/etc/peer-telegram-tracker/env/`, bind-mounted
read-only at `/run/secrets/runtime.json`. Keys matching `*_NEXT` are excluded.
Change values in Infisical; host edits do not persist across deploys. The
snapshot is not stored in this repo or embedded in the image. Startup validates
required keys but accepts extra keys.

The runtime wrapper loads the file and redacts configured credential values from
the child process output. URL values are also redacted without their scheme, so
the HTTPS form of the WebSocket `BASE_RPC` endpoint is covered.

Before creating any clients, startup validates required configuration and URL/token
shapes. Invalid configuration exits with code 1 and prints one stderr line naming
only bad keys and whether they are missing or invalid, never their values. This
fails the deploy's 30-second container-running health check so a bad config deploy
rolls back.

## Health monitor and verification

`aws-health.py` checks the service, image, Telegram, Supabase, Base RPC and disk,
and emits CloudWatch metrics using the EC2 instance role. It reads owner-only
`/etc/peer-telegram-tracker/health-target.json` with `region`, `accountId`,
`instanceId` and `roleName`. The expected image comes from
`/var/lib/peer-rollouts/telegram-tracker-prod/current.json` (`image`); the
legacy `/var/lib/peer-telegram-tracker-migration/build.json` (`app.id`) fallback
applies only if that receipt is missing. Invalid metadata fails the image
check closed.

For credential-dependent checks, the health timer uses `docker inspect
peer-telegram-tracker --format` to resolve the host file bound at
`/run/secrets/runtime.json` in the running container. A stopped or missing
container, missing bind mount, or unreadable/invalid runtime file makes these
checks report false while metrics are still emitted. It never falls back to
the legacy runtime file or logs credential values or file contents.

The monitor runs on the host, outside the image, and publishes
`Peer/TelegramTrackerProd` metrics; CloudWatch alarms reach Slack through SNS and
AWS Chatbot (peer-infra `stacks/alert-routing`). Image deployment does not update
the script: whenever `deploy/aws-health.py` changes, install the reviewed script
through SSM at `/opt/peer-telegram-tracker/aws-health.py`.

Application output: `docker logs peer-telegram-tracker` from an SSM session.

Local verification (Python 3.9 or later and Node from `.nvmrc`):

```sh
actionlint
python3 -m unittest discover -s deploy -v
docker build -f deploy/Dockerfile .
npm run check && npm test
```
