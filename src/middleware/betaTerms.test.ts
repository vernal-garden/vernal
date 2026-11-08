import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { termsGate, BETA_TERMS_ERROR, TERMS_ERROR } from './betaTerms';
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
    betaParticipant: false,
    betaTermsPending: false,
    termsPending: false,
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
    authenticatedAt: null,
    ...overrides,
  };
}

const PENDING = makeSession({ account: makeAccount({ betaParticipant: true, betaTermsPending: true }) });
const CLAIMED = makeSession({ account: makeAccount({ termsPending: true }) });
const BOTH = makeSession({ account: makeAccount({ betaParticipant: true, betaTermsPending: true, termsPending: true }) });

function run(method: string, originalUrl: string, session: SessionData | null) {
  const req = { method, originalUrl, session } as Request;
  const res = makeRes();
  const next = vi.fn();
  termsGate(req, res, next);
  return { res, next };
}

describe('termsGate', () => {
  it('passes a request with no session', () => {
    const { next } = run('GET', '/api/gardens', null);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes a guest', () => {
    const { next } = run('POST', '/api/gardens', makeSession({ isGuest: true }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes a non-participant on every method', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const { res, next } = run(method, '/api/gardens', makeSession({ account: makeAccount() }));
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('passes a participant who has accepted the current terms', () => {
    const accepted = makeSession({ account: makeAccount({ betaParticipant: true, betaTermsPending: false }) });
    const { next } = run('GET', '/api/gardens', accepted);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['DELETE', '/api/auth/session'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/auth/session'],
    ['GET', '/api/auth/oauth/google'],
    ['GET', '/api/config'],
    ['POST', '/api/me/beta-terms'],
    ['POST', '/api/me/terms'],
    ['POST', '/api/me/terms/'],
    ['DELETE', '/api/me'],
    ['GET', '/api/config?x=1'],
    ['GET', '/api/config/'],
    ['POST', '/api/me/beta-terms/'],
    ['POST', '/api/me/beta-terms?x=1'],
    ['GET', '/API/Config'],
    ['DELETE', '/api/ME'],
    ['POST', '/api/me/export'],
    ['GET', '/api/me/export'],
    ['GET', '/api/me/export/download'],
    ['GET', '/api/subscription'],
    ['POST', '/api/subscription/portal'],
    ['POST', '/api/me/cancel-deletion'],
  ])('passes allowlisted %s %s for a pending participant', (method, url) => {
    const { res, next } = run(method, url, PENDING);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/gardens'],
    ['HEAD', '/api/gardens'],
    ['POST', '/api/gardens'],
    ['GET', '/api/me'],
    ['PATCH', '/api/me'],
    ['POST', '/api/config'],
    ['GET', '/api/me/beta-terms'],
    ['PUT', '/api/me/beta-terms'],
    ['GET', '/api/me/terms'],
    ['GET', '/api/me/'],
    ['DELETE', '/api/me/email'],
    ['GET', '/api/config/extra'],
    ['GET', '/api/authx'],
    ['GET', '/api/auth'],
    ['POST', '/api/subscription/checkout'],
    ['DELETE', '/api/me/export'],
    ['POST', '/api/subscription'],
    ['GET', '/api/subscription/portal'],
  ])('refuses %s %s for a pending participant with 403', (method, url) => {
    const { res, next } = run(method, url, PENDING);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(BETA_TERMS_ERROR);
  });

  it('passes an account with nothing pending', () => {
    const { next } = run('GET', '/api/gardens', makeSession({ account: makeAccount({ termsPending: false }) }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('refuses a claimed account with terms_required', () => {
    const { res, next } = run('GET', '/api/gardens', CLAIMED);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(TERMS_ERROR);
  });

  it('answers terms_required when both are pending', () => {
    const { res } = run('POST', '/api/gardens', BOTH);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(TERMS_ERROR);
  });

  it.each([
    ['POST', '/api/me/terms'],
    ['POST', '/api/me/beta-terms'],
    ['GET', '/api/auth/session'],
    ['GET', '/api/config'],
    ['DELETE', '/api/me'],
    ['POST', '/api/me/export'],
    ['POST', '/api/me/cancel-deletion'],
  ])('passes allowlisted %s %s for a claimed account', (method, url) => {
    for (const session of [CLAIMED, BOTH]) {
      const { res, next } = run(method, url, session);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });
});
