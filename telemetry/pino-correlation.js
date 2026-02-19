const { isSpanContextValid, trace } = require('@opentelemetry/api');

function getActiveSpanContext(traceApi = trace) {
  const activeSpan = traceApi.getActiveSpan();
  if (!activeSpan || typeof activeSpan.spanContext !== 'function') return null;

  const spanContext = activeSpan.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return null;

  return spanContext;
}

function createPinoTraceMixin(traceApi = trace) {
  return function pinoTraceMixin() {
    const spanContext = getActiveSpanContext(traceApi);
    if (!spanContext) return {};

    return {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      trace_flags: spanContext.traceFlags,
      span: {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
      },
    };
  };
}

module.exports = {
  createPinoTraceMixin,
  getActiveSpanContext,
};
