type LogLevel = 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN = /email|password|token|secret/i;

function redact(context: LogContext): LogContext {
  const safe: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    safe[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return safe;
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
  const sink = level === 'error' ? console.error : console.log;

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
