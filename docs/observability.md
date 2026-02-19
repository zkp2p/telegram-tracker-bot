# Observability Setup (OpenTelemetry + Pino + Better Stack)

## What is implemented
- OpenTelemetry tracing bootstrap in `telemetry/tracing.js`
- Preload registration in `telemetry/register.js` (loaded before app startup)
- Pino log correlation fields (`trace_id`, `span_id`, `trace_flags`, and `span.*`) in `logger.js`
- No OpenTelemetry Logs SDK usage

## Instrumentation in this repo
`telemetry/tracing.js` enables only what this service actually uses:
- `@opentelemetry/instrumentation-http` (Node HTTP/HTTPS)
- `@opentelemetry/instrumentation-undici` (Node `fetch`)

## Startup behavior
`package.json` preloads tracing automatically:
- `pnpm start` -> `node -r ./telemetry/register.js bot.js`
- `pnpm dev` -> `node -r ./telemetry/register.js bot.js`

Tracing initializes before app code so auto-instrumentation patches are applied in time.

## Better Stack OTLP environment variables
At minimum:
- `BETTERSTACK_SOURCE_TOKEN=<token>`

Optional overrides:
- `BETTERSTACK_OTLP_ENDPOINT=https://in-otel.logs.betterstack.com`
- `BETTERSTACK_OTLP_TRACES_ENDPOINT=https://in-otel.logs.betterstack.com/v1/traces`
- `OTEL_EXPORTER_OTLP_ENDPOINT=<custom collector base URL>`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<custom traces endpoint>`
- `OTEL_EXPORTER_OTLP_HEADERS=key=value,key2=value2`
- `OTEL_EXPORTER_OTLP_TRACES_HEADERS=key=value,key2=value2`

Sampling and batching:
- `OTEL_TRACES_SAMPLER=always_on|always_off|parentbased_traceidratio`
- `OTEL_TRACES_SAMPLER_ARG=0.10` (10% root sampling)
- `OTEL_BSP_MAX_QUEUE_SIZE=2048`
- `OTEL_BSP_MAX_EXPORT_BATCH_SIZE=512`
- `OTEL_BSP_SCHEDULE_DELAY=5000`
- `OTEL_BSP_EXPORT_TIMEOUT=30000`

Service identity:
- `OTEL_SERVICE_NAME=<service-name>`
- `OTEL_SERVICE_VERSION=<service-version>`
- `DEPLOYMENT_ENVIRONMENT=production|staging|dev`

Feature toggles:
- `OTEL_TRACING_ENABLED=true|false`
- `OTEL_SDK_DISABLED=true|false`
- `OTEL_INSTRUMENT_HTTP=true|false`
- `OTEL_INSTRUMENT_UNDICI=true|false`

## Context propagation
`telemetry/tracing.js` registers `AsyncLocalStorageContextManager` on the tracer provider.
This keeps trace context stable across async boundaries in Node.

## Graceful shutdown
`telemetry/register.js` attaches one-time handlers for:
- `SIGTERM`
- `SIGINT`
- `beforeExit`

On shutdown, tracing flushes and closes via provider shutdown.

## Log <-> trace correlation with pino
Every pino log includes active span fields automatically:
- `trace_id`
- `span_id`
- `trace_flags`
- `span.trace_id`
- `span.span_id`

These values are derived from active OpenTelemetry context in-process and do not block request flow.

## Recommended Slack alerts in Better Stack
Route all alert notifications to Slack from Better Stack integrations.

1. Trace error-rate spike
- Condition: `% spans with error status` over 5m
- Scope: per `service.name`, env

2. P95 latency regression
- Condition: p95 duration above SLO for 10m
- Scope: operation + service

3. Trace ingestion stall
- Condition: zero spans from service for N minutes during expected traffic

4. Log error spike
- Condition: count of `level=error` or structured `success=false` exceeds baseline

5. Critical runtime signals
- Condition: logs matching `uncaughtException`, `unhandledRejection`, reconnect loops

6. Dependency degradation
- Condition: high outbound HTTP span error rate to specific dependency

## Determining service down (self + dependencies)
Use Better Stack Uptime as the primary signal:

1. Self service down
- Create uptime monitor for public endpoint(s) and alert after consecutive failures.

2. Worker/background down
- Emit heartbeat pings and alert on missed intervals.

3. Dependency down
- Monitor critical third-party endpoints separately.

4. Telemetry confirmation
- No traces/logs + failed uptime monitor => likely service outage.
- Dependency span failures + healthy self monitor => likely dependency outage.
