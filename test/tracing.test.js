const test = require('node:test');
const assert = require('node:assert/strict');

const tracing = require('../telemetry/tracing');

test.beforeEach(() => {
  tracing.resetTracingStateForTests();
});

test('parse helpers clamp and fallback correctly', () => {
  assert.equal(tracing.parseBoolean('yes'), true);
  assert.equal(tracing.parseBoolean('no', true), false);
  assert.equal(tracing.parseBoolean('maybe', true), true);

  assert.equal(tracing.parseInteger('10', 0, 1, 20), 10);
  assert.equal(tracing.parseInteger('0', 5, 1, 20), 1);
  assert.equal(tracing.parseInteger('100', 5, 1, 20), 20);
  assert.equal(tracing.parseInteger('x', 5, 1, 20), 5);

  assert.equal(tracing.parseRatio('0.5'), 0.5);
  assert.equal(tracing.parseRatio('-1'), 0);
  assert.equal(tracing.parseRatio('2'), 1);
  assert.equal(tracing.parseRatio('x', 0.7), 0.7);
});

test('endpoint normalization and header parsing handle variants', () => {
  assert.equal(tracing.normalizeTracesEndpoint(' https://a.example.com/ '), 'https://a.example.com/v1/traces');
  assert.equal(
    tracing.normalizeTracesEndpoint('https://a.example.com/v1/traces/'),
    'https://a.example.com/v1/traces'
  );
  assert.equal(tracing.normalizeTracesEndpoint('   '), null);
  assert.equal(tracing.normalizeTracesEndpoint(''), null);

  assert.deepEqual(tracing.parseHeaderList('a=b, ,c=hello%20world,broken,=bad,key='), {
    a: 'b',
    c: 'hello world',
  });
  assert.deepEqual(tracing.parseHeaderList(), {});
});

test('config resolution applies precedence and better stack auth defaults', () => {
  const env = {
    BETTERSTACK_SOURCE_TOKEN: 'source-token',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-env=env',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-trace=trace',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
    OTEL_SERVICE_NAME: 'svc',
    OTEL_SERVICE_VERSION: '1.2.3',
    DEPLOYMENT_ENVIRONMENT: 'production',
    OTEL_INSTRUMENT_HTTP: 'false',
    OTEL_INSTRUMENT_UNDICI: 'true',
  };

  const config = tracing.createTracingConfig(env);
  assert.equal(config.enabled, true);
  assert.equal(config.endpoint, 'https://collector.example.com/v1/traces');
  assert.equal(config.serviceName, 'svc');
  assert.equal(config.serviceVersion, '1.2.3');
  assert.equal(config.environment, 'production');
  assert.equal(config.instrumentHttp, false);
  assert.equal(config.instrumentUndici, true);
  assert.deepEqual(config.headers, {
    'x-env': 'env',
    'x-trace': 'trace',
    Authorization: 'Bearer source-token',
    'x-source-token': 'source-token',
  });
});

test('resolveTraceHeaders keeps existing auth headers', () => {
  const headers = tracing.resolveTraceHeaders({
    BETTERSTACK_SOURCE_TOKEN: 'token',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20preexisting,x-source-token=existing',
  });

  assert.equal(headers.authorization, 'Bearer preexisting');
  assert.equal(headers['x-source-token'], 'existing');
  assert.equal(headers.Authorization, undefined);
});

test('sampler, batch config, timeout and compression follow environment values', () => {
  assert.equal(tracing.resolveSamplerRatio({ OTEL_TRACES_SAMPLER: 'always_off' }), 0);
  assert.equal(tracing.resolveSamplerRatio({ OTEL_TRACES_SAMPLER: 'always_on' }), 1);
  assert.equal(tracing.resolveSamplerRatio({ OTEL_TRACES_SAMPLER_ARG: '0.25' }), 0.25);
  assert.equal(tracing.resolveSamplerRatio({ BETTERSTACK_TRACE_SAMPLING_RATIO: '0.1' }), 0.1);

  const batch = tracing.resolveBatchSpanProcessorConfig({
    OTEL_BSP_MAX_QUEUE_SIZE: '10',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '50',
    OTEL_BSP_SCHEDULE_DELAY: '100',
    OTEL_BSP_EXPORT_TIMEOUT: '200',
  });

  assert.deepEqual(batch, {
    maxQueueSize: 10,
    maxExportBatchSize: 10,
    scheduledDelayMillis: 100,
    exportTimeoutMillis: 200,
  });

  assert.equal(tracing.resolveExporterTimeoutMillis({ OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '500' }), 500);
  assert.equal(tracing.resolveCompression({ OTEL_EXPORTER_OTLP_COMPRESSION: 'none' }), 'none');
  assert.equal(tracing.resolveCompression({ OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip' }), 'gzip');
});

test('createInstrumentations respects toggles', () => {
  class FakeHttpInstrumentation {}
  class FakeUndiciInstrumentation {}

  const both = tracing.createInstrumentations(
    { instrumentHttp: true, instrumentUndici: true },
    { HttpInstrumentation: FakeHttpInstrumentation, UndiciInstrumentation: FakeUndiciInstrumentation }
  );
  assert.equal(both.length, 2);
  assert.ok(both[0] instanceof FakeHttpInstrumentation);
  assert.ok(both[1] instanceof FakeUndiciInstrumentation);

  const httpOnly = tracing.createInstrumentations(
    { instrumentHttp: true, instrumentUndici: false },
    { HttpInstrumentation: FakeHttpInstrumentation, UndiciInstrumentation: FakeUndiciInstrumentation }
  );
  assert.equal(httpOnly.length, 1);
  assert.ok(httpOnly[0] instanceof FakeHttpInstrumentation);

  const none = tracing.createInstrumentations(
    { instrumentHttp: false, instrumentUndici: false },
    { HttpInstrumentation: FakeHttpInstrumentation, UndiciInstrumentation: FakeUndiciInstrumentation }
  );
  assert.deepEqual(none, []);
});

test('startTracing returns disabled state when no endpoint/token exists', async () => {
  const state = tracing.startTracing({ env: {} });
  assert.equal(state.enabled, false);
  assert.equal(tracing.getTracingState(), state);
  await state.shutdown();
});

test('startTracing initializes provider, registers instrumentations, and shuts down once', async () => {
  const calls = {
    setLogger: 0,
    registerCalls: [],
    providerRegisterCalls: [],
    providerShutdownCalls: 0,
    unregisterCalls: 0,
  };

  class FakeExporter {
    constructor(options) {
      this.options = options;
    }
  }

  class FakeSpanProcessor {
    constructor(exporter, config) {
      this.exporter = exporter;
      this.config = config;
    }
  }

  class FakeParentSampler {
    constructor(config) {
      this.config = config;
    }
  }

  class FakeTraceRatioSampler {
    constructor(ratio) {
      this.ratio = ratio;
    }
  }

  class FakeContextManager {}

  class FakeProvider {
    constructor(config) {
      this.config = config;
    }

    register(config) {
      calls.providerRegisterCalls.push(config);
    }

    shutdown() {
      calls.providerShutdownCalls += 1;
      return Promise.resolve();
    }
  }

  class FakeHttpInstrumentation {
    constructor() {
      this.instrumentationName = 'http';
    }
  }

  class FakeUndiciInstrumentation {
    constructor() {
      this.instrumentationName = 'undici';
    }
  }

  const fakeDependencies = {
    NodeTracerProvider: FakeProvider,
    BatchSpanProcessor: FakeSpanProcessor,
    ParentBasedSampler: FakeParentSampler,
    TraceIdRatioBasedSampler: FakeTraceRatioSampler,
    OTLPTraceExporter: FakeExporter,
    AsyncLocalStorageContextManager: FakeContextManager,
    HttpInstrumentation: FakeHttpInstrumentation,
    UndiciInstrumentation: FakeUndiciInstrumentation,
    resourceFromAttributes: (attributes) => ({ attributes, kind: 'resource' }),
    registerInstrumentations: (args) => {
      calls.registerCalls.push(args);
      return () => {
        calls.unregisterCalls += 1;
      };
    },
    diag: {
      setLogger() {
        calls.setLogger += 1;
      },
    },
    DiagConsoleLogger: class {},
    DiagLogLevel: { INFO: 'info' },
  };

  const env = {
    BETTERSTACK_SOURCE_TOKEN: 'token',
    OTEL_ENABLE_DIAGNOSTICS: 'true',
    OTEL_TRACES_SAMPLER_ARG: '0.5',
    SERVICE_NAME: 'demo-service',
    npm_package_version: '9.9.9',
    NODE_ENV: 'test',
  };

  const state = tracing.startTracing({ env, dependencies: fakeDependencies });
  assert.equal(state.enabled, true);
  assert.equal(calls.setLogger, 1);
  assert.equal(state.instrumentations.length, 2);
  assert.equal(calls.registerCalls.length, 1);
  assert.equal(calls.registerCalls[0].instrumentations.length, 2);
  assert.equal(calls.providerRegisterCalls.length, 1);

  const registerConfig = calls.providerRegisterCalls[0];
  assert.ok(registerConfig.contextManager instanceof FakeContextManager);
  assert.equal(state.resource.attributes['service.name'], 'demo-service');
  assert.equal(state.resource.attributes['service.version'], '9.9.9');
  assert.equal(state.resource.attributes['deployment.environment'], 'test');

  const exporterOptions = state.exporter.options;
  assert.equal(exporterOptions.url, tracing.DEFAULT_BETTERSTACK_TRACES_ENDPOINT);
  assert.equal(exporterOptions.timeoutMillis, 10000);
  assert.equal(exporterOptions.compression, 'gzip');
  assert.equal(exporterOptions.headers.Authorization, 'Bearer token');

  const secondState = tracing.startTracing({ env, dependencies: fakeDependencies });
  assert.equal(secondState, state);

  await state.shutdown();
  await state.shutdown();
  assert.equal(calls.unregisterCalls, 1);
  assert.equal(calls.providerShutdownCalls, 1);
});

test('resolveTraceEndpoint honors explicit traces endpoint precedence', () => {
  const env = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/custom',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
    BETTERSTACK_OTLP_ENDPOINT: 'https://ignored.example.com',
  };

  assert.equal(
    tracing.resolveTraceEndpoint(env),
    'https://traces.example.com/custom/v1/traces'
  );
  assert.equal(
    tracing.resolveTraceEndpoint({ BETTERSTACK_OTLP_TRACES_ENDPOINT: 'https://bs-traces.example.com' }),
    'https://bs-traces.example.com/v1/traces'
  );
  assert.equal(
    tracing.resolveTraceEndpoint({ BETTERSTACK_OTLP_ENDPOINT: 'https://bs-generic.example.com' }),
    'https://bs-generic.example.com/v1/traces'
  );
  assert.equal(tracing.resolveTracingEnabled({ OTEL_TRACING_ENABLED: 'false' }), false);
  assert.equal(tracing.resolveTracingEnabled({ OTEL_SDK_DISABLED: 'true' }), false);
});

test('startTracing can read from process.env when explicit env is omitted', async () => {
  tracing.resetTracingStateForTests();

  const previousEnv = process.env;
  try {
    process.env = {
      ...previousEnv,
      BETTERSTACK_SOURCE_TOKEN: 'token-from-process-env',
      OTEL_ENABLE_DIAGNOSTICS: 'false',
      OTEL_INSTRUMENT_HTTP: 'false',
      OTEL_INSTRUMENT_UNDICI: 'false',
    };

    const calls = { register: 0, shutdown: 0 };

    class FakeProvider {
      constructor(_config) {}
      register(_config) {}
      shutdown() {
        calls.shutdown += 1;
        return Promise.resolve();
      }
    }

    const state = tracing.startTracing({
      dependencies: {
        NodeTracerProvider: FakeProvider,
        BatchSpanProcessor: class {
          constructor(_exporter, _config) {}
        },
        ParentBasedSampler: class {
          constructor(_config) {}
        },
        TraceIdRatioBasedSampler: class {
          constructor(_ratio) {}
        },
        OTLPTraceExporter: class {
          constructor(_options) {}
        },
        AsyncLocalStorageContextManager: class {},
        HttpInstrumentation: class {},
        UndiciInstrumentation: class {},
        resourceFromAttributes: (attributes) => ({ attributes }),
        registerInstrumentations: (args) => {
          calls.register += 1;
          assert.deepEqual(args.instrumentations, []);
          return () => undefined;
        },
        diag: { setLogger() {} },
        DiagConsoleLogger: class {},
        DiagLogLevel: { INFO: 'info' },
      },
    });

    assert.equal(state.enabled, true);
    assert.equal(calls.register, 1);
    assert.equal(state.instrumentations.length, 0);

    await state.shutdown();
    assert.equal(calls.shutdown, 1);
  } finally {
    process.env = previousEnv;
  }
});
