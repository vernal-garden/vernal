import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Sentry from '@sentry/node';
import { logger } from './logger';

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

describe('logger', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  describe('Sentry reporting', () => {
    it('error with an Error captures the exception with redacted extras', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = new Error('boom');

      logger.error('GET /seeds failed', err, { accountId: 7, email: 'a@b.c' });

      expect(Sentry.captureException).toHaveBeenCalledWith(err, {
        extra: { message: 'GET /seeds failed', accountId: 7, email: '[REDACTED]' },
      });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('error without an error captures a message at level error', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('budget exceeded');

      expect(Sentry.captureMessage).toHaveBeenCalledWith('budget exceeded', {
        level: 'error',
        extra: {},
      });
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('warn and info capture nothing', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.warn('slow query', { ms: 900 });
      logger.info('started');

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('logger.info', () => {
    it('writes output containing the message string', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('garden created');

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toContain('garden created');
    });
  });

  describe('logger.error', () => {
    it('in production mode outputs valid JSON with level:error and the message', () => {
      process.env.NODE_ENV = 'production';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('checkout failed');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.level).toBe('error');
      expect(parsed.message).toBe('checkout failed');
    });

    it('with an Error instance includes errMsg and stack in output', () => {
      process.env.NODE_ENV = 'production';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('db connection failed', new Error('connection refused'));

      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.errMsg).toBe('connection refused');
      expect(typeof parsed.stack).toBe('string');
    });

    it('with a non-Error value includes an err field', () => {
      process.env.NODE_ENV = 'production';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('unexpected rejection', 'string reason');

      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.err).toBe('string reason');
    });
  });

  describe('logger.info redaction', () => {
    it('redacts a nested sensitive key', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('profile updated', { user: { email: 'a@b.com' } });

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('a@b.com');
    });

    it('redacts a sensitive key inside an array of objects', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('bulk import', { users: [{ email: 'a@b.com' }, { email: 'c@d.com' }] });

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('a@b.com');
      expect(output).not.toContain('c@d.com');
    });

    it('leaves a non-sensitive nested value intact', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('garden created', { garden: { name: 'Backyard' } });

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain('Backyard');
    });

    it('does not throw on a circular context object', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      type CircularContext = Record<string, unknown> & { self?: CircularContext };
      const circular: CircularContext = { name: 'loop' };
      circular.self = circular;

      expect(() => logger.info('circular context', circular)).not.toThrow();
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain('[CIRCULAR]');
    });
  });

  describe('logger.warn', () => {
    it('writes to console.warn, not console.log', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.warn('low disk space');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
