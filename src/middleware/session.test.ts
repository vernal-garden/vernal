import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../lib/sessions', () => ({
  COOKIE_NAME: '_vernal_sid',
  findSession: vi.fn(),
}));

import { findSession } from '../lib/sessions';
import { sessionMiddleware } from './session';

const findSessionMock = vi.mocked(findSession);

function fakeRes() {
  const res = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  return Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json(body: unknown) {
      res.body = body;
      return this;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return this;
    },
  });
}

describe('sessionMiddleware', () => {
  // Braces matter: vitest treats a function returned from beforeEach as teardown
  // and would call the mock (and its rejected value) after the test.
  beforeEach(() => {
    findSessionMock.mockReset();
  });

  it('sets session null and continues when there is no cookie', async () => {
    const req = { cookies: {} } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    await sessionMiddleware(req, fakeRes() as unknown as Response, next);
    expect(req.session).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets session null and skips the lookup when the cookie is not a string', async () => {
    const req = { cookies: { _vernal_sid: 1 } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    await sessionMiddleware(req, fakeRes() as unknown as Response, next);
    expect(req.session).toBeNull();
    expect(findSessionMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets session null and continues when the lookup finds nothing', async () => {
    findSessionMock.mockResolvedValue(null);
    const req = { cookies: { _vernal_sid: 'tok.sig' } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    await sessionMiddleware(req, fakeRes() as unknown as Response, next);
    expect(req.session).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it('responds 503 and does not continue when the lookup throws', async () => {
    findSessionMock.mockRejectedValue(new Error('connection terminated'));
    const req = { cookies: { _vernal_sid: 'tok.sig' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await sessionMiddleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect(res.body).toEqual({ error: 'Server is busy — please try again shortly' });
    expect(req.session).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });
});
