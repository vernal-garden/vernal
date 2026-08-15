type LogLevel = 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN = /email|password|token|secret/i;

function isPlainObject(value: unknown): value is LogContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const safe: LogContext = {};
    for (const [key, v] of Object.entries(value)) {
      safe[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(v, seen);
    }
    return safe;
  }

  return value;
}

function redact(context: LogContext): LogContext {
  return redactValue(context, new WeakSet()) as LogContext;
}

function serializeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return { errMsg: error.message, stack: error.stack };
  }
  return { err: error };
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function write(level: LogLevel, message: string, context: LogContext = {}) {
  const safeContext = redact(context);
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (isProduction()) {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeContext }));
    return;
  }

  const contextSuffix = Object.keys(safeContext).length > 0 ? ` ${JSON.stringify(safeContext)}` : '';
  sink(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${contextSuffix}`);
}

export const logger = {
  info(message: string, context?: LogContext) {
    write('info', message, context);
  },
  warn(message: string, context?: LogContext) {
    write('warn', message, context);
  },
  error(message: string, error?: unknown, context?: LogContext) {
    const errorContext = error !== undefined ? serializeError(error) : {};
    write('error', message, { ...errorContext, ...context });
  },
};
