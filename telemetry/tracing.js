const { DiagConsoleLogger, DiagLogLevel, diag } = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} = require('@opentelemetry/sdk-trace-base');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');

const DEFAULT_BETTERSTACK_TRACES_ENDPOINT = 'https://in-otel.logs.betterstack.com/v1/traces';
const DEFAULT_BATCH_CONFIG = Object.freeze({
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: 30000,
});

let tracingState = null;

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function parseRatio(value, fallback = 1) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function normalizeTracesEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return null;
  const trimmed = endpoint.trim();
  if (!trimmed) return null;

  const noTrailingSlash = trimmed.replace(/\/+$/, '');
  if (/\/v\d+\/traces$/i.test(noTrailingSlash)) {
    return noTrailingSlash;
  }

  return `${noTrailingSlash}/v1/traces`;
}

function parseHeaderList(value) {
  if (!value || typeof value !== 'string') return {};

  const headers = {};
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || !rawValue) continue;

    headers[key] = decodeURIComponent(rawValue);
  }

  return headers;
}

function resolveTraceEndpoint(env) {
  const tracesEndpoint = normalizeTracesEndpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  if (tracesEndpoint) return tracesEndpoint;

  const betterStackTraceEndpoint = normalizeTracesEndpoint(env.BETTERSTACK_OTLP_TRACES_ENDPOINT);
  if (betterStackTraceEndpoint) return betterStackTraceEndpoint;

  const genericOtlpEndpoint = normalizeTracesEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (genericOtlpEndpoint) return genericOtlpEndpoint;

  const betterStackEndpoint = normalizeTracesEndpoint(env.BETTERSTACK_OTLP_ENDPOINT);
  if (betterStackEndpoint) return betterStackEndpoint;

  if (env.BETTERSTACK_SOURCE_TOKEN) return DEFAULT_BETTERSTACK_TRACES_ENDPOINT;

  return null;
}

function resolveTraceHeaders(env) {
  const traceHeaders = parseHeaderList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
  const globalHeaders = parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS);
  const headers = { ...globalHeaders, ...traceHeaders };

  if (env.BETTERSTACK_SOURCE_TOKEN) {
    if (!headers.authorization && !headers.Authorization) {
      headers.Authorization = `Bearer ${env.BETTERSTACK_SOURCE_TOKEN}`;
    }
    if (!headers['x-source-token'] && !headers['X-Source-Token']) {
      headers['x-source-token'] = env.BETTERSTACK_SOURCE_TOKEN;
    }
  }

  return headers;
}

function resolveSamplerRatio(env) {
  const sampler = String(env.OTEL_TRACES_SAMPLER || '').trim().toLowerCase();
  if (sampler === 'always_off') return 0;
  if (sampler === 'always_on') return 1;

  const ratioFromStandardArg = parseRatio(env.OTEL_TRACES_SAMPLER_ARG, NaN);
  if (Number.isFinite(ratioFromStandardArg)) return ratioFromStandardArg;

  return parseRatio(env.BETTERSTACK_TRACE_SAMPLING_RATIO, 1);
}

function resolveBatchSpanProcessorConfig(env) {
  const maxQueueSize = parseInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULT_BATCH_CONFIG.maxQueueSize, 1);
  const maxExportBatchSize = parseInteger(
    env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE,
    DEFAULT_BATCH_CONFIG.maxExportBatchSize,
    1,
    maxQueueSize
  );

  return {
    maxQueueSize,
    maxExportBatchSize,
    scheduledDelayMillis: parseInteger(
      env.OTEL_BSP_SCHEDULE_DELAY,
      DEFAULT_BATCH_CONFIG.scheduledDelayMillis,
      1
    ),
    exportTimeoutMillis: parseInteger(
      env.OTEL_BSP_EXPORT_TIMEOUT,
      DEFAULT_BATCH_CONFIG.exportTimeoutMillis,
      1
    ),
  };
}

function resolveExporterTimeoutMillis(env) {
  return parseInteger(
    env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT,
    10000,
    1
  );
}

function resolveCompression(env) {
  const configured = String(
    env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION ?? env.OTEL_EXPORTER_OTLP_COMPRESSION ?? 'gzip'
  )
    .trim()
    .toLowerCase();

  return configured === 'none' ? 'none' : 'gzip';
}

function resolveServiceName(env) {
  return env.OTEL_SERVICE_NAME || env.SERVICE_NAME || 'telegram-tracker-bot';
}

function resolveServiceVersion(env) {
  return env.OTEL_SERVICE_VERSION || env.npm_package_version || 'unknown';
}

function resolveEnvironmentName(env) {
  return env.DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'development';
}

function resolveTracingEnabled(env) {
  const explicitlyDisabled = parseBoolean(env.OTEL_SDK_DISABLED, false) ||
    !parseBoolean(env.OTEL_TRACING_ENABLED, true);
  if (explicitlyDisabled) return false;

  return Boolean(resolveTraceEndpoint(env));
}

function createTracingConfig(env = process.env) {
  return {
    enabled: resolveTracingEnabled(env),
    endpoint: resolveTraceEndpoint(env),
    headers: resolveTraceHeaders(env),
    samplerRatio: resolveSamplerRatio(env),
    batchConfig: resolveBatchSpanProcessorConfig(env),
    exporterTimeoutMillis: resolveExporterTimeoutMillis(env),
    compression: resolveCompression(env),
    serviceName: resolveServiceName(env),
    serviceVersion: resolveServiceVersion(env),
    environment: resolveEnvironmentName(env),
    enableDiagnostics: parseBoolean(env.OTEL_ENABLE_DIAGNOSTICS, false),
    instrumentHttp: parseBoolean(env.OTEL_INSTRUMENT_HTTP, true),
    instrumentUndici: parseBoolean(env.OTEL_INSTRUMENT_UNDICI, true),
  };
}

function createResourceAttributes(config) {
  return {
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'deployment.environment': config.environment,
  };
}

function createInstrumentations(config, deps) {
  const instrumentations = [];

  if (config.instrumentHttp) {
    instrumentations.push(new deps.HttpInstrumentation());
  }

  if (config.instrumentUndici) {
    instrumentations.push(new deps.UndiciInstrumentation());
  }

  return instrumentations;
}

function startTracing(options = {}) {
  if (tracingState) return tracingState;

  const env = options.env || process.env;
  const config = createTracingConfig(env);

  if (!config.enabled) {
    tracingState = {
      enabled: false,
      config,
      shutdown: async () => undefined,
    };
    return tracingState;
  }

  const deps = {
    NodeTracerProvider,
    BatchSpanProcessor,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
    OTLPTraceExporter,
    AsyncLocalStorageContextManager,
    registerInstrumentations,
    HttpInstrumentation,
    UndiciInstrumentation,
    resourceFromAttributes,
    diag,
    DiagConsoleLogger,
    DiagLogLevel,
    ...options.dependencies,
  };

  if (config.enableDiagnostics) {
    deps.diag.setLogger(new deps.DiagConsoleLogger(), deps.DiagLogLevel.INFO);
  }

  const exporter = new deps.OTLPTraceExporter({
    url: config.endpoint,
    headers: config.headers,
    timeoutMillis: config.exporterTimeoutMillis,
    compression: config.compression,
  });

  const spanProcessor = new deps.BatchSpanProcessor(exporter, config.batchConfig);

  const resource = deps.resourceFromAttributes(createResourceAttributes(config));
  const provider = new deps.NodeTracerProvider({
    resource,
    sampler: new deps.ParentBasedSampler({
      root: new deps.TraceIdRatioBasedSampler(config.samplerRatio),
    }),
    spanProcessors: [spanProcessor],
  });

  const contextManager = new deps.AsyncLocalStorageContextManager();
  provider.register({ contextManager });

  const instrumentations = createInstrumentations(config, deps);

  const unregisterInstrumentations = deps.registerInstrumentations({
    tracerProvider: provider,
    instrumentations,
  });

  let shutdownPromise;
  const shutdown = async () => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (typeof unregisterInstrumentations === 'function') {
          unregisterInstrumentations();
        }
        await provider.shutdown();
      })();
    }

    return shutdownPromise;
  };

  tracingState = {
    enabled: true,
    config,
    exporter,
    provider,
    resource,
    spanProcessor,
    contextManager,
    instrumentations,
    shutdown,
  };

  return tracingState;
}

function getTracingState() {
  return tracingState;
}

function resetTracingStateForTests() {
  tracingState = null;
}

module.exports = {
  DEFAULT_BETTERSTACK_TRACES_ENDPOINT,
  createInstrumentations,
  createTracingConfig,
  createResourceAttributes,
  getTracingState,
  normalizeTracesEndpoint,
  parseBoolean,
  parseHeaderList,
  parseInteger,
  parseRatio,
  resetTracingStateForTests,
  resolveBatchSpanProcessorConfig,
  resolveCompression,
  resolveExporterTimeoutMillis,
  resolveSamplerRatio,
  resolveTraceEndpoint,
  resolveTraceHeaders,
  resolveTracingEnabled,
  startTracing,
};
