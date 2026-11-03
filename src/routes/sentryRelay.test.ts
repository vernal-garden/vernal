import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import app from '../index';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';
import { createSentryRelayRouter } from './sentryRelay';

const target = { host: 'o1.ingest.us.sentry.io', projectId: '4511', publicKey: 'abc123' };
const ourDsn = 'https://abc123@o1.ingest.us.sentry.io/4511';
const forwardUrl = 'https://o1.ingest.us.sentry.io/api/4511/envelope/';

function envelope(dsn: unknown): string {
  return `${JSON.stringify({ event_id: 'e1', sent_at: '2026-11-03T00:00:00Z', dsn })}\n{"type":"event"}\n{"message":"héllo"}\n`;
}

function post(body: string | Buffer, contentType = 'text/plain;charset=UTF-8') {
  return request(app).post('/api/relay').set('Content-Type', contentType).send(body);
}

const original = getServerConfig();
let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  setServerConfigForTests({ ...original, sentryRelay: target });
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  setServerConfigForTests(original);
  fetchSpy.mockRestore();
});

describe('POST /api/relay', () => {
  it('forwards an envelope for our project byte-for-byte and passes Sentry\'s answer back', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{"id":"e1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Sentry-Rate-Limits': '60:error:org' },
      }),
    );
    const body = envelope(ourDsn);

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.text).toBe('{"id":"e1"}');
    expect(res.headers['x-sentry-rate-limits']).toBe('60:error:org');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After, X-Sentry-Rate-Limits');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(forwardUrl);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-sentry-envelope');
    expect(Buffer.from(init.body as Uint8Array).equals(Buffer.from(body, 'utf8'))).toBe(true);
  });

  it('refuses a compressed body with 415 and forwards nothing', async () => {
    const res = await request(app)
      .post('/api/relay')
      .set('Content-Type', 'text/plain')
      .set('Content-Encoding', 'gzip')
      .send(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(res.status).toBe(415);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards a binary envelope byte-for-byte', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const sent = Buffer.concat([
      Buffer.from(`${JSON.stringify({ event_id: 'e1', dsn: ourDsn })}\n`, 'utf8'),
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    ]);

    // No explicit Content-Type: supertest picks application/octet-stream for a Buffer.
    const res = await request(app).post('/api/relay').send(sent);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(Buffer.from(init.body as Uint8Array).equals(sent)).toBe(true);
  });

  it('forwards no cookies or client IP headers', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await post(envelope(ourDsn))
      .set('Cookie', '_vernal_sid=x')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Content-Type']);
  });

  it('passes Sentry\'s 429 and Retry-After through', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    const res = await post(envelope(ourDsn));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
  });

  it.each([
    ['another project', 'https://abc123@o1.ingest.us.sentry.io/9999'],
    ['another host', 'https://abc123@evil.example.com/4511'],
    ['another public key', 'https://zzz@o1.ingest.us.sentry.io/4511'],
    ['no dsn', undefined],
    ['a non-string dsn', 42],
  ])('refuses an envelope with %s and forwards nothing', async (_label, dsn) => {
    const res = await post(envelope(dsn));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid envelope' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an empty body or a header line that is not JSON', async () => {
    expect((await post('')).status).toBe(400);
    expect((await post('not json\n{}\n')).status).toBe(400);
    expect((await post('[1,2]\n{}\n')).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a JSON body (consumed by the global parser)', async () => {
    const res = await request(app).post('/api/relay').send({ dsn: ourDsn });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 404 when the relay is not configured', async () => {
    setServerConfigForTests({ ...original, sentryRelay: undefined });
    const res = await post(envelope(ourDsn));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 413 for a body over 1 MB', async () => {
    const big = envelope(ourDsn) + 'x'.repeat(1024 * 1024 + 1);
    const res = await post(big);
    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 502 when Sentry is unreachable', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    const res = await post(envelope(ourDsn));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Relay failed' });
  });
});

describe('createSentryRelayRouter timeout', () => {
  it('gives up after timeoutMs and answers 502', async () => {
    // A fetch that only settles when aborted.
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const small = express();
    small.use('/relay', createSentryRelayRouter({ timeoutMs: 20 }));

    const res = await request(small)
      .post('/relay')
      .set('Content-Type', 'text/plain')
      .send(envelope(ourDsn));

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Relay failed' });
  });
});
