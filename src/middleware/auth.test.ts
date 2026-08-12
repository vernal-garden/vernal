import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { requireSupporter } from './auth';
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

describe('requireSupporter', () => {
  it('calls next() for a supporter account', () => {
    const req = { session: makeSession({ account: makeAccount({ subscriptionTier: 'supporter' }) }) } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireSupporter(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 402 with upgrade_required for a free account', () => {
    const req = { session: makeSession({ account: makeAccount({ subscriptionTier: 'free' }) }) } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireSupporter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Supporter subscription required',
      upgrade_required: true,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a guest session', () => {
    const req = { session: makeSession({ isGuest: true, account: null }) } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireSupporter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a session with no account', () => {
    const req = { session: makeSession({ isGuest: false, account: null }) } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireSupporter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no session at all', () => {
    const req = { session: null } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireSupporter(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });
});
