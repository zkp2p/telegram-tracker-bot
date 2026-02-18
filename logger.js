const { Writable } = require('stream');
const pino = require('pino');

const SERVICE_NAME = process.env.SERVICE_NAME || 'telegram-tracker-bot';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN || '';
const BETTERSTACK_ENDPOINT = (
  process.env.BETTERSTACK_ENDPOINT ||
  'https://in.logs.betterstack.com'
).replace(/\/+$/, '');

const inflightRequests = new Set();

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeError(error) {
  if (!(error instanceof Error)) return {};
  return {
    err: error,
    error_name: error.name,
    error_message: error.message,
    error_stack: error.stack,
  };
}

function normalizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return normalizeError(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeValue(item, seen));
    seen.delete(value);
    return normalized;
  }

  const normalized = {};
  for (const [key, nested] of Object.entries(value)) {
    normalized[key] = normalizeValue(nested, seen);
  }
  seen.delete(value);
  return normalized;
}

function normalizeMeta(value) {
  if (value instanceof Error) return normalizeError(value);
  if (isPlainObject(value)) return normalizeValue(value);
  return {};
}

function sendToBetterStack(payload) {
  if (!BETTERSTACK_SOURCE_TOKEN || typeof fetch !== 'function') return;

  const request = fetch(BETTERSTACK_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BETTERSTACK_SOURCE_TOKEN}`,
      'x-source-token': BETTERSTACK_SOURCE_TOKEN,
    },
    body: JSON.stringify(payload),
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      inflightRequests.delete(request);
    });

  inflightRequests.add(request);
}

class BetterStackStream extends Writable {
  constructor() {
    super({ decodeStrings: false });
  }

  _write(chunk, _encoding, callback) {
    const line = String(chunk || '').trim();
    if (!line) {
      callback();
      return;
    }

    try {
      sendToBetterStack(JSON.parse(line));
    } catch {
      sendToBetterStack({
        service: SERVICE_NAME,
        env: process.env.NODE_ENV || 'development',
        message: line,
      });
    }

    callback();
  }
}

const streams = [{ stream: process.stdout }];
if (BETTERSTACK_SOURCE_TOKEN) {
  streams.push({ stream: new BetterStackStream() });
}

const pinoLogger = pino(
  {
    level: LOG_LEVEL,
    base: {
      service: SERVICE_NAME,
      env: process.env.NODE_ENV || 'development',
    },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  },
  pino.multistream(streams, { dedupe: true })
);

function parseArgs(args) {
  if (args.length === 0) return { message: 'runtime_event', meta: {} };

  const [first, ...rest] = args;

  if (isPlainObject(first)) {
    const meta = normalizeMeta(first);

    if (typeof rest[0] === 'string') {
      const [message, ...extraArgs] = rest;
      if (extraArgs.length > 0) {
        meta.args = extraArgs.map((arg) => normalizeValue(arg));
      }
      return { message, meta };
    }

    if (rest.length > 0) {
      meta.args = rest.map((arg) => normalizeValue(arg));
    }

    if (typeof meta.message === 'string') {
      const message = meta.message;
      delete meta.message;
      return { message, meta };
    }

    return { message: 'runtime_event', meta };
  }

  if (first instanceof Error) {
    const meta = normalizeError(first);
    if (rest.length > 0) {
      meta.args = rest.map((arg) => normalizeValue(arg));
    }
    return { message: first.message || 'runtime_error', meta };
  }

  if (typeof first === 'string') {
    if (rest.length === 0) return { message: first, meta: {} };
    if (rest.length === 1 && (isPlainObject(rest[0]) || rest[0] instanceof Error)) {
      return { message: first, meta: normalizeMeta(rest[0]) };
    }
    return {
      message: first,
      meta: { args: rest.map((arg) => normalizeValue(arg)) },
    };
  }

  return {
    message: String(first),
    meta: rest.length > 0 ? { args: rest.map((arg) => normalizeValue(arg)) } : {},
  };
}

function log(pinoInstance, level, args) {
  const { message, meta } = parseArgs(args);
  if (Object.keys(meta).length === 0) {
    pinoInstance[level](message);
    return;
  }
  pinoInstance[level](meta, message);
}

function createLogger(pinoInstance) {
  return {
    debug(...args) {
      log(pinoInstance, 'debug', args);
    },
    info(...args) {
      log(pinoInstance, 'info', args);
    },
    warn(...args) {
      log(pinoInstance, 'warn', args);
    },
    error(...args) {
      log(pinoInstance, 'error', args);
    },
    child(bindings = {}) {
      return createLogger(pinoInstance.child(normalizeValue(bindings)));
    },
  };
}

const logger = createLogger(pinoLogger);

async function flushLogs() {
  if (inflightRequests.size === 0) return;
  await Promise.allSettled(Array.from(inflightRequests));
}

module.exports = {
  logger,
  flushLogs,
};
