const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPinoTraceMixin,
  getActiveSpanContext,
} = require('../telemetry/pino-correlation');

test('getActiveSpanContext returns null when no span is active', () => {
  const traceApi = { getActiveSpan: () => null };
  assert.equal(getActiveSpanContext(traceApi), null);
});

test('getActiveSpanContext returns null when span context is invalid', () => {
  const traceApi = {
    getActiveSpan: () => ({
      spanContext: () => ({
        traceId: 'invalid',
        spanId: 'invalid',
      }),
    }),
  };

  assert.equal(getActiveSpanContext(traceApi), null);
});

test('createPinoTraceMixin injects trace fields from active span', () => {
  const traceApi = {
    getActiveSpan: () => ({
      spanContext: () => ({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
      }),
    }),
  };

  const mixin = createPinoTraceMixin(traceApi);
  assert.deepEqual(mixin(), {
    trace_id: '0123456789abcdef0123456789abcdef',
    span_id: '0123456789abcdef',
    trace_flags: 1,
    span: {
      trace_id: '0123456789abcdef0123456789abcdef',
      span_id: '0123456789abcdef',
    },
  });
});

test('createPinoTraceMixin returns empty object when no valid span exists', () => {
  const traceApi = {
    getActiveSpan: () => ({ spanContext: () => null }),
  };

  const mixin = createPinoTraceMixin(traceApi);
  assert.deepEqual(mixin(), {});
});
