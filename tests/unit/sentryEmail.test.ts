import { describe, it, expect } from 'vitest';
import {
  maskEmails,
  maskEmailsDeep,
  scrubBreadcrumbEmails,
  scrubEventEmails,
  stripBreadcrumbQueries,
  stripEventQueries,
} from '../../client/src/lib/sentryEmail';

const ADDR = 'jane.doe@example.com';

describe('scrubEventEmails', () => {
  it('masks the message and every exception value', () => {
    const event = {
      message: `failed for ${ADDR}`,
      exception: { values: [{ value: `bad ${ADDR}` }, { value: 'clean' }, { value: `x ${ADDR} y` }] },
    };
    scrubEventEmails(event);
    expect(event.message).toBe('failed for [EMAIL]');
    expect(event.exception.values.map((v) => v.value)).toEqual(['bad [EMAIL]', 'clean', 'x [EMAIL] y']);
  });

  it('masks breadcrumb message and data, and tolerates a breadcrumb with no data', () => {
    const event = {
      breadcrumbs: [
        { message: `to ${ADDR}`, data: { to: ADDR, nested: { list: [ADDR] } } },
        { message: 'no data here' },
      ],
    };
    scrubEventEmails(event);
    expect(event.breadcrumbs[0].message).toBe('to [EMAIL]');
    expect(event.breadcrumbs[0].data).toEqual({ to: '[EMAIL]', nested: { list: ['[EMAIL]'] } });
    expect(event.breadcrumbs[1]).toEqual({ message: 'no data here' });
  });

  it('masks extra, contexts, tags, trace data and span data at depth', () => {
    const event = {
      extra: { a: { b: { c: ADDR } } },
      contexts: { custom: { owner: ADDR }, trace: { data: { who: ADDR } } },
      tags: { user_email: ADDR },
      spans: [{ description: 'ok', data: { deep: { arr: [{ e: ADDR }] } } }],
    };
    scrubEventEmails(event);
    expect(event.extra).toEqual({ a: { b: { c: '[EMAIL]' } } });
    expect(event.contexts).toEqual({ custom: { owner: '[EMAIL]' }, trace: { data: { who: '[EMAIL]' } } });
    expect(event.tags).toEqual({ user_email: '[EMAIL]' });
    expect(event.spans[0].data).toEqual({ deep: { arr: [{ e: '[EMAIL]' }] } });
  });

  it('masks transaction, request.url and span descriptions', () => {
    const event = {
      transaction: `user ${ADDR}`,
      request: { url: `https://app.test/p?e=${ADDR}` },
      spans: [{ description: `GET ${ADDR}` }, {}],
    };
    scrubEventEmails(event);
    expect(event.transaction).toBe('user [EMAIL]');
    expect(event.request.url).not.toContain(ADDR);
    expect(event.request.url).toContain('[EMAIL]');
    expect(event.spans[0].description).toBe('GET [EMAIL]');
  });

  it('returns the same event object and tolerates an empty event', () => {
    const event = {};
    expect(scrubEventEmails(event)).toBe(event);
  });

  it('never lets an address through anywhere in an event (privacy)', () => {
    const secret = 'unique.canary+tag@sub.privacy-test.example.org';
    const event = {
      message: secret,
      transaction: secret,
      exception: { values: [{ value: secret }] },
      breadcrumbs: [{ message: secret, data: { a: secret, b: { c: [secret] } } }],
      extra: { x: secret, y: [{ z: secret }] },
      contexts: { c: { d: secret }, trace: { data: { t: secret } } },
      tags: { t: secret },
      request: { url: `https://x.test/?e=${secret}` },
      spans: [{ description: secret, data: { s: secret } }],
    };
    scrubEventEmails(event);
    const json = JSON.stringify(event);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('privacy-test');
    expect(json).toContain('[EMAIL]');
  });
});

describe('scrubBreadcrumbEmails', () => {
  it('masks message and data directly and returns the same crumb', () => {
    const crumb = { message: `hi ${ADDR}`, data: { who: ADDR } };
    expect(scrubBreadcrumbEmails(crumb)).toBe(crumb);
    expect(crumb).toEqual({ message: 'hi [EMAIL]', data: { who: '[EMAIL]' } });
  });

  it('handles a crumb with no message or data', () => {
    const crumb = { category: 'ui.click' };
    expect(scrubBreadcrumbEmails(crumb)).toEqual({ category: 'ui.click' });
  });
});

describe('maskEmailsDeep', () => {
  it('returns [Truncated] for objects past depth 8', () => {
    let nested: Record<string, unknown> = { leaf: ADDR };
    for (let i = 0; i < 12; i++) nested = { child: nested };
    const json = JSON.stringify(maskEmailsDeep(nested));
    expect(json).toContain('[Truncated]');
    expect(json).not.toContain(ADDR);
  });

  it('keeps structures within the depth limit', () => {
    expect(maskEmailsDeep({ a: { b: ADDR } })).toEqual({ a: { b: '[EMAIL]' } });
  });

  it('passes through non-string primitives', () => {
    expect(maskEmailsDeep(5)).toBe(5);
    expect(maskEmailsDeep(null)).toBeNull();
    expect(maskEmailsDeep(true)).toBe(true);
  });
});

describe('query stripping', () => {
  it('strips the query from a fetch breadcrumb url', () => {
    const crumb = {
      category: 'fetch',
      data: { url: '/api/admin/accounts?email=jane%40example.com', method: 'GET' },
    };
    stripBreadcrumbQueries(crumb);
    expect(crumb.data).toEqual({ url: '/api/admin/accounts', method: 'GET' });
  });

  it('strips navigation from/to and fragments', () => {
    const crumb = { data: { from: '/verify-email?token=a', to: '/account#x' } };
    stripBreadcrumbQueries(crumb);
    expect(crumb.data).toEqual({ from: '/verify-email', to: '/account' });
  });

  it('strips span descriptions and span data, redacting query keys', () => {
    const event = {
      transaction: '/reset?token=x',
      request: { url: 'https://app.test/a?email=jane%40example.com#h' },
      spans: [
        {
          description: 'GET /api/admin/accounts?email=jane%40example.com',
          data: {
            'url.full': 'https://app.test/api/admin/accounts?email=jane%40example.com',
            'http.url': '/api/x?a=1',
            url: '/api/y?b=2',
            'http.query': '?email=jane%40example.com',
            'url.query': 'email=jane%40example.com',
            'http.method': 'GET',
          },
        },
        {},
      ],
      contexts: { trace: { data: { 'http.query': 'q=1', url: '/z?q=1' } } },
    };
    stripEventQueries(event);
    expect(event.transaction).toBe('/reset');
    expect(event.request.url).toBe('https://app.test/a');
    expect(event.spans[0].description).toBe('GET /api/admin/accounts');
    expect(event.spans[0].data).toEqual({
      'url.full': 'https://app.test/api/admin/accounts',
      'http.url': '/api/x',
      url: '/api/y',
      'http.query': '[REDACTED]',
      'url.query': '[REDACTED]',
      'http.method': 'GET',
    });
    expect(event.spans[1]).toEqual({});
    expect(event.contexts.trace.data).toEqual({ 'http.query': '[REDACTED]', url: '/z' });
  });

  it('adds no keys to objects that lacked them', () => {
    const event = { spans: [{}], request: {} };
    scrubEventEmails(stripEventQueries(event));
    expect(event).toEqual({ spans: [{}], request: {} });
  });
});

describe('maskEmails', () => {
  it('masks plus-addressed and subdomain addresses', () => {
    expect(maskEmails('a+news@example.com')).toBe('[EMAIL]');
    expect(maskEmails('b@mail.eu.example.co.uk')).toBe('[EMAIL]');
  });

  it('is stable across repeated calls and leaves clean text alone', () => {
    for (let i = 0; i < 4; i++) expect(maskEmails(`x ${ADDR} y`)).toBe('x [EMAIL] y');
    expect(maskEmails('nothing to see at all')).toBe('nothing to see at all');
    expect(maskEmails('@handle and a@b')).toBe('@handle and a@b');
  });
});
