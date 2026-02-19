const { startTracing } = require('./tracing');

let hooksInstalled = false;

function installShutdownHooks({ processObj = process, shutdown } = {}) {
  if (hooksInstalled || typeof shutdown !== 'function') return;
  hooksInstalled = true;

  const invokeShutdown = () => {
    Promise.resolve()
      .then(() => shutdown())
      .catch((error) => {
        processObj.stderr.write(
          `[otel] shutdown failed: ${error && error.message ? error.message : String(error)}\n`
        );
      });
  };

  processObj.once('SIGTERM', invokeShutdown);
  processObj.once('SIGINT', invokeShutdown);
  processObj.once('beforeExit', invokeShutdown);
}

function resetHooksForTests() {
  hooksInstalled = false;
}

function registerTracing(options = {}) {
  try {
    const state = startTracing(options);
    if (state && state.enabled) {
      installShutdownHooks({ processObj: options.processObj || process, shutdown: state.shutdown });
    }
    return state;
  } catch (error) {
    (options.processObj || process).stderr.write(
      `[otel] failed to initialize tracing: ${error && error.message ? error.message : String(error)}\n`
    );

    return {
      enabled: false,
      config: {},
      shutdown: async () => undefined,
    };
  }
}

const tracingRegistration = registerTracing();

module.exports = {
  installShutdownHooks,
  registerTracing,
  resetHooksForTests,
  tracingRegistration,
};
