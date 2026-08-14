import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from './logger';

describe('logger', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
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
});
