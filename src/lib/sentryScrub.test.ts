import { describe, it, expect } from 'vitest';
import type { Event } from '@sentry/node';
import { scrubEvent, maskEmails } from './sentryScrub';

describe('scrubEvent', () => {
  it('masks email addresses in the message and exception values', () => {
    const event: Event = {
      message: 'Send to someone@example.com failed',
      exception: { values: [{ type: 'Error', value: 'Recipient <Jo.Bloggs+x@mail.example.org> rejected' }] },
    };
    const out = scrubEvent(event);
    expect(out.message).toBe('Send to [EMAIL] failed');
    expect(out.exception?.values?.[0].value).toBe('Recipient <[EMAIL]> rejected');
  });

  it('removes request body, cookies, headers and query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.vernal.garden/api/auth/reset-password?token=abc',
        data: { password: 'hunter22', token: 'abc' },
        cookies: { _vernal_sid: 'x' },
        headers: { cookie: '_vernal_sid=x' },
        query_string: 'token=abc',
      },
    };
    const out = scrubEvent(event);
    expect(out.request).toEqual({ url: 'https://app.vernal.garden/api/auth/reset-password' });
  });

  it('strips query strings from breadcrumb urls', () => {
    const out = scrubEvent({
      breadcrumbs: [
        { category: 'navigation', data: { from: '/verify-email?token=a', to: '/account' } },
        { category: 'http', data: { url: '/api/me/email/confirm?token=b', method: 'GET' } },
      ],
    });
    expect(out.breadcrumbs![0].data).toEqual({ from: '/verify-email', to: '/account' });
    expect(out.breadcrumbs![1].data).toEqual({ url: '/api/me/email/confirm', method: 'GET' });
  });

  it('redacts tokens in console breadcrumbs and drops their arguments', () => {
    const out = scrubEvent({
      breadcrumbs: [
        {
          category: 'console',
          message: 'Reset link: https://x/reset?token=abc123&y=1 done',
          data: { arguments: ['https://x/reset?token=abc123'], logger: 'console' },
        },
      ],
    });
    expect(out.breadcrumbs![0].message).toBe('Reset link: https://x/reset?token=[REDACTED]&y=1 done');
    expect(out.breadcrumbs![0].data).toEqual({ logger: 'console' });
  });

  it('masks email addresses in breadcrumb messages and Postgres key errors', () => {
    const out = scrubEvent({
      exception: { values: [{ type: 'Error', value: 'Key (email)=(jo@example.com) already exists.' }] },
      breadcrumbs: [{ category: 'console', message: 'POST /me failed: jo@example.com taken' }],
    });
    expect(out.exception?.values?.[0].value).toBe('Key (email)=([EMAIL]) already exists.');
    expect(out.breadcrumbs![0].message).toBe('POST /me failed: [EMAIL] taken');
  });

  it('strips query strings from transaction and span descriptions, and drops user', () => {
    const out = scrubEvent({
      transaction: 'GET /reset?token=x',
      user: { id: '1' },
      spans: [{ description: 'GET /a?token=y' }],
    } as unknown as Event);
    expect(out.transaction).toBe('GET /reset');
    expect(out.user).toBeUndefined();
    expect((out as unknown as { spans: Array<{ description: string }> }).spans[0].description).toBe('GET /a');
  });

  it('fails closed on deeply nested data', () => {
    let deep: Record<string, unknown> = { secretLeaf: 'x', safe: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    const out = scrubEvent({ extra: deep } as unknown as Event);
    expect(JSON.stringify(out.extra)).toContain('[Truncated]');
    expect(JSON.stringify(out.extra)).not.toContain('safe');
  });

  it('redacts sensitive keys and query attributes in extra, contexts and spans', () => {
    const out = scrubEvent({
      extra: { accessToken: 't', nested: { password: 'p', ok: 1 } },
      contexts: { trace: { data: { 'url.full': 'https://x/a?token=1', 'http.query': 'token=1' } } },
      spans: [{ data: { 'http.url': 'https://x/b?token=2', authorization: 'Bearer z' } }],
    } as unknown as Event);
    expect(out.extra).toEqual({ accessToken: '[REDACTED]', nested: { password: '[REDACTED]', ok: 1 } });
    expect((out.contexts as Record<string, { data: Record<string, unknown> }>).trace.data).toEqual({
      'url.full': 'https://x/a',
      'http.query': '[REDACTED]',
    });
    expect((out as unknown as { spans: Array<{ data: Record<string, unknown> }> }).spans[0].data).toEqual({
      'http.url': 'https://x/b',
      authorization: '[REDACTED]',
    });
  });

  it('masks addresses in extra, contexts, tags, span data and breadcrumb data, nested and in arrays', () => {
    const out = scrubEvent({
      tags: { who: 'a@b.com', count: 3 },
      extra: { a: 'x@y.com', l1: { l2: { v: 'deep@y.com' } }, list: ['p@q.com', { n: 'r@s.com' }] },
      contexts: { c: { l1: { l2: 'ctx@y.com' }, list: ['c2@y.com'] } },
      spans: [{ data: { v: 'sp@y.com', l1: { l2: 'sp2@y.com' }, list: ['sp3@y.com'] } }],
      breadcrumbs: [{ category: 'x', data: { v: 'bc@y.com', l1: { l2: 'bc2@y.com' }, list: ['bc3@y.com'] } }],
    } as unknown as Event);
    expect(out.tags).toEqual({ who: '[EMAIL]', count: 3 });
    expect(out.extra).toEqual({
      a: '[EMAIL]',
      l1: { l2: { v: '[EMAIL]' } },
      list: ['[EMAIL]', { n: '[EMAIL]' }],
    });
    expect(out.contexts).toEqual({ c: { l1: { l2: '[EMAIL]' }, list: ['[EMAIL]'] } });
    expect((out as unknown as { spans: Array<{ data: unknown }> }).spans[0].data).toEqual({
      v: '[EMAIL]',
      l1: { l2: '[EMAIL]' },
      list: ['[EMAIL]'],
    });
    expect(out.breadcrumbs![0].data).toEqual({ v: '[EMAIL]', l1: { l2: '[EMAIL]' }, list: ['[EMAIL]'] });
  });

  it('masks addresses in the transaction, request url and span description and still strips queries', () => {
    const out = scrubEvent({
      transaction: 'GET /u/jo@example.com?token=x',
      request: { url: 'https://app.vernal.garden/u/jo@example.com/page?token=y' },
      spans: [{ description: 'GET /u/jo@example.com?token=z' }],
    } as unknown as Event);
    // The address pattern also swallows adjacent path characters, which is fine: it over-masks.
    expect(out.transaction).toBe('GET [EMAIL]');
    expect(out.request?.url).toBe('[EMAIL]');
    expect((out as unknown as { spans: Array<{ description: string }> }).spans[0].description).toBe('GET [EMAIL]');
  });

  it('masks addresses under URL-like keys holding arrays or objects', () => {
    const out = scrubEvent({
      extra: { to: ['a@b.com'], from: { address: 'a@b.com' } },
    } as unknown as Event);
    expect(out.extra).toEqual({ to: ['[EMAIL]'], from: { address: '[EMAIL]' } });
  });

  it('keeps sensitive keys as [REDACTED] rather than [EMAIL]', () => {
    const out = scrubEvent({
      extra: { password: 'jo@example.com', token: 'jo@example.com', nested: { authorization: 'jo@example.com' } },
    } as unknown as Event);
    expect(out.extra).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
    });
  });
});

describe('maskEmails', () => {
  it('masks both inputs when called twice in a row', () => {
    expect(maskEmails('first a@b.com here')).toBe('first [EMAIL] here');
    expect(maskEmails('second c@d.org there')).toBe('second [EMAIL] there');
  });

  it('leaves text with no address unchanged', () => {
    expect(maskEmails('nothing to see at 5 pm')).toBe('nothing to see at 5 pm');
  });
});
