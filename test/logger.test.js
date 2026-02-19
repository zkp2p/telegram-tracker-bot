const test = require('node:test');
const assert = require('node:assert/strict');

const LOGGER_MODULE_PATH = require.resolve('../logger');
const PINO_MIXIN_MODULE_PATH = require.resolve('../telemetry/pino-correlation');

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function restoreEnvironment() {
  process.env = { ...originalEnv };
  if (typeof originalFetch === 'undefined') {
    delete global.fetch;
  } else {
    global.fetch = originalFetch;
  }
}

function loadLogger({ env = {}, fetchImpl, mixinFactory } = {}) {
  delete require.cache[LOGGER_MODULE_PATH];
  delete require.cache[PINO_MIXIN_MODULE_PATH];

  process.env = { ...originalEnv, ...env };

  if (typeof fetchImpl === 'undefined') {
    delete global.fetch;
  } else {
    global.fetch = fetchImpl;
  }

  if (mixinFactory) {
    require.cache[PINO_MIXIN_MODULE_PATH] = {
      id: PINO_MIXIN_MODULE_PATH,
      filename: PINO_MIXIN_MODULE_PATH,
      loaded: true,
      exports: {
        createPinoTraceMixin: mixinFactory,
      },
    };
  }

  return require('../logger');
}

function captureStdout(run) {
  const output = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk, encoding, callback) => {
    output.push(String(chunk));

    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }

    return true;
  };

  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output.join('');
}

test.afterEach(() => {
  restoreEnvironment();
  delete require.cache[LOGGER_MODULE_PATH];
  delete require.cache[PINO_MIXIN_MODULE_PATH];
});

test('normalize helpers and parseArgs cover object, error, string and fallback paths', () => {
  const loggerModule = loadLogger();
  const { normalizeError, normalizeMeta, normalizeValue, parseArgs } = loggerModule.__private;

  const error = new Error('boom');
  const circular = { id: 1n };
  circular.self = circular;

  const normalized = normalizeValue({
    id: 1n,
    err: error,
    nested: [circular],
  });

  assert.equal(normalized.id, '1');
  assert.equal(normalized.err.error_message, 'boom');
  assert.equal(normalized.nested[0].self, '[Circular]');

  assert.deepEqual(normalizeMeta(error).error_name, 'Error');
  assert.deepEqual(normalizeMeta({ value: 1 }).value, 1);
  assert.deepEqual(normalizeMeta('x'), {});
  assert.deepEqual(normalizeError('x'), {});

  assert.deepEqual(parseArgs([]), { message: 'runtime_event', meta: {} });

  assert.deepEqual(parseArgs([{ a: 1 }, 'msg', 2]), {
    message: 'msg',
    meta: { a: 1, args: [2] },
  });

  assert.deepEqual(parseArgs([{ message: 'from_meta', ok: true }]), {
    message: 'from_meta',
    meta: { ok: true },
  });
  assert.deepEqual(parseArgs([{ ok: true }]), {
    message: 'runtime_event',
    meta: { ok: true },
  });
  assert.deepEqual(parseArgs([{ ok: true }, 1, 2]), {
    message: 'runtime_event',
    meta: { ok: true, args: [1, 2] },
  });

  const parsedError = parseArgs([error, { extra: 1 }]);
  assert.equal(parsedError.message, 'boom');
  assert.deepEqual(parsedError.meta.args, [{ extra: 1 }]);
  const emptyMessageError = new Error('');
  assert.deepEqual(parseArgs([emptyMessageError]), {
    message: 'runtime_error',
    meta: {
      err: emptyMessageError,
      error_name: 'Error',
      error_message: '',
      error_stack: emptyMessageError.stack,
    },
  });

  assert.deepEqual(parseArgs(['plain']), { message: 'plain', meta: {} });
  assert.deepEqual(parseArgs(['plain', { yes: true }]), {
    message: 'plain',
    meta: { yes: true },
  });
  const parsedStringWithErrorMeta = parseArgs(['plain', new Error('meta-error')]);
  assert.equal(parsedStringWithErrorMeta.message, 'plain');
  assert.equal(parsedStringWithErrorMeta.meta.error_message, 'meta-error');
  assert.deepEqual(parseArgs(['plain', 1, 2]), {
    message: 'plain',
    meta: { args: [1, 2] },
  });

  assert.deepEqual(parseArgs([10]), {
    message: '10',
    meta: {},
  });
  assert.deepEqual(parseArgs([10, 'extra']), {
    message: '10',
    meta: { args: ['extra'] },
  });
});

test('createLogger and log route methods and preserve child bindings', () => {
  const loggerModule = loadLogger();
  const { createLogger } = loggerModule.__private;

  const calls = [];
  const childCalls = [];

  const childInstance = {
    debug(meta, message) {
      calls.push(['child_debug', meta, message]);
    },
    info(meta, message) {
      calls.push(['child_info', meta, message]);
    },
    warn(meta, message) {
      calls.push(['child_warn', meta, message]);
    },
    error(meta, message) {
      calls.push(['child_error', meta, message]);
    },
    child(bindings) {
      childCalls.push(bindings);
      return childInstance;
    },
  };

  const pinoStub = {
    debug(meta, message) {
      calls.push(['debug', meta, message]);
    },
    info(meta, message) {
      calls.push(['info', meta, message]);
    },
    warn(meta, message) {
      calls.push(['warn', meta, message]);
    },
    error(meta, message) {
      calls.push(['error', meta, message]);
    },
    child(bindings) {
      childCalls.push(bindings);
      return childInstance;
    },
  };

  const logger = createLogger(pinoStub);
  logger.debug('debug message');
  logger.info({ ok: true }, 'info message');
  logger.warn(new Error('warn error'));
  logger.error('error message', 1, 2);

  const child = logger.child({ id: 9n });
  child.info('child info');

  assert.equal(calls[0][0], 'debug');
  assert.equal(calls[0][1], 'debug message');
  assert.equal(calls[1][0], 'info');
  assert.deepEqual(calls[1][1], { ok: true });
  assert.equal(calls[1][2], 'info message');
  assert.equal(calls[2][0], 'warn');
  assert.match(calls[2][1].error_message, /warn error/);
  assert.equal(calls[2][2], 'warn error');
  assert.equal(calls[3][0], 'error');
  assert.deepEqual(calls[3][1], { args: [1, 2] });
  assert.equal(calls[3][2], 'error message');
  assert.equal(calls[4][0], 'child_info');
  assert.equal(calls[4][1], 'child info');

  assert.deepEqual(childCalls[0], { id: '9' });
});

test('sendToBetterStack and BetterStackStream handle disabled, success and failure cases', async () => {
  const payloads = [];
  const loggerModule = loadLogger({
    env: {
      BETTERSTACK_SOURCE_TOKEN: 'token',
      BETTERSTACK_ENDPOINT: 'https://example.com///',
    },
    fetchImpl: (url, options) => {
      payloads.push({ url, options });
      if (payloads.length === 1) return Promise.resolve({ ok: true });
      return Promise.reject(new Error('network fail'));
    },
  });

  const { BetterStackStream, sendToBetterStack } = loggerModule.__private;

  // Direct send: success then failure path
  sendToBetterStack({ message: 'direct-1' });
  sendToBetterStack({ message: 'direct-2' });

  // Stream parse: empty line, JSON line, fallback plain line
  const stream = new BetterStackStream();
  await new Promise((resolve) => stream._write(undefined, 'utf8', resolve));
  await new Promise((resolve) => stream._write('\n', 'utf8', resolve));
  await new Promise((resolve) => stream._write('{"event":"json"}\n', 'utf8', resolve));
  await new Promise((resolve) => stream._write('plain text\n', 'utf8', resolve));

  await loggerModule.flushLogs();

  assert.equal(payloads.length, 4);
  assert.equal(payloads[0].url, 'https://example.com');
  assert.equal(payloads[0].options.headers.authorization, 'Bearer token');
  assert.equal(payloads[0].options.headers['x-source-token'], 'token');
  assert.deepEqual(JSON.parse(payloads[2].options.body), { event: 'json' });
  assert.equal(JSON.parse(payloads[3].options.body).message, 'plain text');
});

test('sendToBetterStack short-circuits when token or fetch is unavailable', async () => {
  let called = false;
  const loggerModule = loadLogger({
    env: {
      BETTERSTACK_SOURCE_TOKEN: '',
    },
    fetchImpl: () => {
      called = true;
      return Promise.resolve({ ok: true });
    },
  });

  loggerModule.__private.sendToBetterStack({ msg: 'skip' });
  await loggerModule.flushLogs();
  assert.equal(called, false);

  const moduleWithoutFetch = loadLogger({
    env: {
      BETTERSTACK_SOURCE_TOKEN: 'token',
    },
    fetchImpl: undefined,
  });

  moduleWithoutFetch.__private.sendToBetterStack({ msg: 'skip-no-fetch' });
  await moduleWithoutFetch.flushLogs();
  assert.equal(called, false);
});

test('logger output includes trace correlation fields from pino mixin', () => {
  const loggerModule = loadLogger({
    mixinFactory: () => () => ({
      trace_id: 'trace-123',
      span_id: 'span-456',
    }),
  });

  const output = captureStdout(() => {
    loggerModule.logger.info('trace-aware-message');
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(output.length, 1);
  assert.equal(output[0].message, 'trace-aware-message');
  assert.equal(output[0].trace_id, 'trace-123');
  assert.equal(output[0].span_id, 'span-456');
});
