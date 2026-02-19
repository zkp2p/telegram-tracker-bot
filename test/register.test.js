const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function loadRegisterWithStartTracing(startTracingImpl) {
  const tracingPath = require.resolve('../telemetry/tracing');
  const registerPath = require.resolve('../telemetry/register');

  delete require.cache[registerPath];
  delete require.cache[tracingPath];

  require.cache[tracingPath] = {
    id: tracingPath,
    filename: tracingPath,
    loaded: true,
    exports: { startTracing: startTracingImpl },
  };

  return require('../telemetry/register');
}

function createFakeProcess() {
  const emitter = new EventEmitter();
  const writes = [];

  emitter.stderr = {
    write(message) {
      writes.push(message);
    },
  };

  return { emitter, writes };
}

test('registerTracing installs shutdown hooks when tracing is enabled', async () => {
  let shutdownCalls = 0;
  const register = loadRegisterWithStartTracing(() => ({
    enabled: true,
    shutdown: async () => {
      shutdownCalls += 1;
    },
  }));

  register.resetHooksForTests();
  const { emitter } = createFakeProcess();

  const state = register.registerTracing({ processObj: emitter });
  assert.equal(state.enabled, true);

  emitter.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shutdownCalls, 1);
});

test('installShutdownHooks is idempotent and reports shutdown failures', async () => {
  const register = loadRegisterWithStartTracing(() => ({
    enabled: false,
    shutdown: async () => undefined,
  }));

  register.resetHooksForTests();

  const { emitter, writes } = createFakeProcess();
  let calls = 0;

  register.installShutdownHooks({
    processObj: emitter,
    shutdown: async () => {
      calls += 1;
      throw 'shutdown exploded';
    },
  });

  register.installShutdownHooks({
    processObj: emitter,
    shutdown: async () => {
      calls += 100;
    },
  });

  emitter.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  assert.match(writes.join(''), /shutdown failed/);
});

test('installShutdownHooks reports shutdown errors using Error.message branch', async () => {
  const register = loadRegisterWithStartTracing(() => ({
    enabled: false,
    shutdown: async () => undefined,
  }));

  register.resetHooksForTests();

  const { emitter, writes } = createFakeProcess();

  register.installShutdownHooks({
    processObj: emitter,
    shutdown: async () => {
      throw new Error('shutdown-error-object');
    },
  });

  emitter.emit('beforeExit');
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(writes.join(''), /shutdown-error-object/);
});

test('registerTracing handles startup failures gracefully (string error)', async () => {
  const register = loadRegisterWithStartTracing(() => {
    throw 'init failed';
  });

  register.resetHooksForTests();
  const { emitter, writes } = createFakeProcess();

  const state = register.registerTracing({ processObj: emitter });
  assert.equal(state.enabled, false);
  assert.equal(typeof state.shutdown, 'function');
  assert.match(writes.join(''), /failed to initialize tracing/);
  await state.shutdown();
});

test('registerTracing handles startup failures gracefully (Error object)', () => {
  const register = loadRegisterWithStartTracing(() => {
    throw new Error('init failed object');
  });

  register.resetHooksForTests();
  const { emitter, writes } = createFakeProcess();

  const state = register.registerTracing({ processObj: emitter });
  assert.equal(state.enabled, false);
  assert.match(writes.join(''), /init failed object/);
  assert.equal(typeof state.shutdown, 'function');
});

test('installShutdownHooks ignores invalid shutdown handlers', async () => {
  const register = loadRegisterWithStartTracing(() => ({
    enabled: false,
    shutdown: async () => undefined,
  }));

  register.resetHooksForTests();
  const { emitter, writes } = createFakeProcess();

  register.installShutdownHooks({ processObj: emitter, shutdown: undefined });
  emitter.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 0);
});
