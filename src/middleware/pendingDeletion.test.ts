import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { blockWhilePendingDeletion, PENDING_DELETION_ERROR } from './pendingDeletion';
import { SessionData, SessionAccount } from '../types';

function makeRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeAccount(overrides: Partial<SessionAccount> = {}): SessionAccount {
  return {
    id: 1,
    email: 'test@example.com',
    role: 'user',
    subscriptionTier: 'free',
    deletionScheduledAt: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-id',
    token: 'token',
    isGuest: false,
    expiresAt: new Date(),
    account: null,
    ...overrides,
  };
}

const PENDING = makeSession({ account: makeAccount({ deletionScheduledAt: '2026-10-01T00:00:00.000Z' }) });

function run(method: string, originalUrl: string, session: SessionData | null) {
  const req = { method, originalUrl, session } as Request;
  const res = makeRes();
  const next = vi.fn();
  blockWhilePendingDeletion(req, res, next);
  return { res, next };
}

describe('blockWhilePendingDeletion', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('passes %s for a pending account', (method) => {
    const { res, next } = run(method, '/api/gardens', PENDING);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes a request with no session', () => {
    const { next } = run('POST', '/api/gardens', null);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes a guest', () => {
    const { next } = run('POST', '/api/gardens', makeSession({ isGuest: true }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes an account with no deletion pending', () => {
    const { next } = run('PATCH', '/api/me', makeSession({ account: makeAccount() }));
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/auth/oauth/google'],
    ['POST', '/api/me/cancel-deletion'],
    ['DELETE', '/api/me'],
    ['POST', '/api/me/export'],
    ['POST', '/api/events/batch'],
    ['POST', '/api/me/cancel-deletion?x=1'],
    ['POST', '/api/me/cancel-deletion/'],
    ['DELETE', '/api/ME'],
  ])('passes allowlisted %s %s for a pending account', (method, url) => {
    const { res, next } = run(method, url, PENDING);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['PATCH', '/api/me'],
    ['POST', '/api/gardens'],
    ['DELETE', '/api/gardens/1'],
    ['POST', '/api/subscription/portal'],
    ['POST', '/api/subscription/checkout'],
    ['DELETE', '/api/me/email'],
    ['POST', '/api/me/export/extra'],
    ['POST', '/api/authx'],
  ])('blocks %s %s for a pending account with 409', (method, url) => {
    const { res, next } = run(method, url, PENDING);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(PENDING_DELETION_ERROR);
  });
});
