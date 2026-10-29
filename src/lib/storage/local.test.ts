import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import express from 'express';
import request from 'supertest';
import { ConfigError } from '../serverConfig';
import { localDriver as local } from './local';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vernal-local-'));
  vi.stubEnv('MEDIA_DIR', dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function read(stream: Readable | null): Promise<string> {
  if (!stream) throw new Error('expected a stream');
  let text = '';
  for await (const chunk of stream) text += (chunk as Buffer).toString();
  return text;
}

const put = (key: string, text = key, area: 'media' | 'exports' = 'media') =>
  local.put(area, key, Buffer.from(text), 'image/jpeg');

describe('local storage driver', () => {
  it('round-trips a put through getStream, in the right area folder', async () => {
    await put('seed-photos/1/a.jpg', 'hello');
    expect(await read(await local.getStream('media', 'seed-photos/1/a.jpg'))).toBe('hello');
    await expect(fs.readFile(path.join(dir, 'media', 'seed-photos', '1', 'a.jpg'), 'utf8')).resolves.toBe('hello');
    expect(await local.getStream('exports', 'seed-photos/1/a.jpg')).toBeNull();
  });

  it('putStream writes the whole stream and leaves no temp file', async () => {
    await local.putStream('exports', 'exports/3/9.zip', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 'application/zip');
    expect(await read(await local.getStream('exports', 'exports/3/9.zip'))).toBe('abcd');
    expect(await fs.readdir(path.join(dir, 'exports', 'exports', '3'))).toEqual(['9.zip']);
  });

  it('putStream removes its temp file when the stream fails', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('source failed'));
      },
    });
    await expect(local.putStream('exports', 'exports/3/9.zip', failing, 'application/zip')).rejects.toThrow('source failed');
    expect(await fs.readdir(path.join(dir, 'exports', 'exports', '3'))).toEqual([]);
  });

  it('returns null for a missing object', async () => {
    expect(await local.getStream('media', 'seed-photos/1/missing.jpg')).toBeNull();
  });

  it('removes an object, and a missing one is fine', async () => {
    await put('seed-photos/1/a.jpg');
    await local.remove('media', 'seed-photos/1/a.jpg');
    expect(await local.getStream('media', 'seed-photos/1/a.jpg')).toBeNull();
    await expect(local.remove('media', 'seed-photos/1/a.jpg')).resolves.toBeUndefined();
    await expect(local.remove('media', 'nowhere/at/all.jpg')).resolves.toBeUndefined();
  });

  it("removePrefix removes the folder tree and leaves 'seed-photos/50/'", async () => {
    await put('seed-photos/5/a.jpg');
    await put('seed-photos/5/nested/b.jpg');
    await put('seed-photos/50/c.jpg');
    await local.removePrefix('media', 'seed-photos/5/');
    expect(await local.listKeys('media', 'seed-photos/')).toEqual(['seed-photos/50/c.jpg']);
    await expect(local.removePrefix('media', 'seed-photos/6/')).resolves.toBeUndefined();
    await expect(local.removePrefix('media', 'seed-photos/5')).rejects.toThrow('must end with /');
  });

  it('lists folders, keys and objects like S3, skipping in-flight temp files', async () => {
    await put('seed-photos/1/a.jpg');
    await put('seed-photos/1/b.jpg');
    await put('seed-photos/2/c.jpg');
    await put('harvest-photos/7/d.jpg');
    await fs.writeFile(path.join(dir, 'media', 'seed-photos', '2', 'e.jpg.tmp-123'), 'partial');

    expect(await local.listFolders('media', 'seed-photos/')).toEqual(['seed-photos/1/', 'seed-photos/2/']);
    expect(await local.listFolders('media', '')).toEqual(['harvest-photos/', 'seed-photos/']);
    expect(await local.listKeys('media', 'seed-photos/')).toEqual([
      'seed-photos/1/a.jpg',
      'seed-photos/1/b.jpg',
      'seed-photos/2/c.jpg',
    ]);
    expect(await local.listKeys('media', 'seed-photos/1/')).toEqual(['seed-photos/1/a.jpg', 'seed-photos/1/b.jpg']);

    const objects = await local.listObjects('media', 'seed-photos/2/');
    expect(objects).toEqual([{ key: 'seed-photos/2/c.jpg', lastModified: expect.any(Date) }]);

    expect(await local.listFolders('media', 'garden-thumbnails/')).toEqual([]);
    expect(await local.listKeys('exports', 'exports/')).toEqual([]);
    expect(await local.listObjects('media', 'nothing/')).toEqual([]);
  });

  it('rejects keys that could leave their area', async () => {
    const bad = ['../x', 'seed-photos/../../x', '/abs', 'a\\b', '', '.'];
    // A drive-absolute key resolves outside the area without '..' or a leading '/'.
    if (process.platform === 'win32') bad.push('C:/outside.jpg');
    for (const key of bad) {
      await expect(local.put('media', key, Buffer.from('x'), 'image/jpeg'), key).rejects.toThrow('Invalid storage key');
      await expect(local.getStream('media', key), key).rejects.toThrow('Invalid storage key');
      await expect(local.remove('media', key), key).rejects.toThrow('Invalid storage key');
    }
    await expect(local.listKeys('media', '../')).rejects.toThrow('Invalid storage key');
    await expect(local.removePrefix('media', '/')).rejects.toThrow('Invalid storage key');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  describe('responses', () => {
    const app = express();
    app.get('/media/*key', async (req, res) => {
      await local.sendMedia(res, req.path.slice('/media/'.length));
    });
    app.get('/download/*key', async (req, res) => {
      await local.sendDownload(res, 'exports', req.path.slice('/download/'.length), 'vernal-export-2026-10-28.zip', 300);
    });

    it('sendMedia streams the file with its type, length and private caching', async () => {
      await put('seed-photos/1/a.jpg', 'jpeg-bytes');
      const res = await request(app).get('/media/seed-photos/1/a.jpg');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-length']).toBe('10');
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      expect(Buffer.from(res.body).toString()).toBe('jpeg-bytes');

      await local.put('media', 'garden-thumbnails/2/t.png', Buffer.from('png'), 'image/png');
      const png = await request(app).get('/media/garden-thumbnails/2/t.png');
      expect(png.headers['content-type']).toBe('image/png');
    });

    it('sendMedia 404s on a missing file', async () => {
      const res = await request(app).get('/media/seed-photos/1/missing.jpg');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('treats a key naming a directory as missing', async () => {
      await put('seed-photos/1/a.jpg');
      expect(await local.getStream('media', 'seed-photos/1')).toBeNull();
      const res = await request(app).get('/media/seed-photos/1');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('sendMedia resolves without an error when the client goes away partway', async () => {
      await local.put('media', 'seed-photos/1/big.jpg', Buffer.alloc(1024 * 1024, 1), 'image/jpeg');
      let received = 0;
      // A response whose client disconnects after the first chunk.
      const res = new Writable({
        write(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          cb();
          this.destroy();
        },
      });
      const fakeRes = Object.assign(res, {
        set: () => fakeRes,
        status: () => fakeRes,
      }) as unknown as express.Response;

      await expect(local.sendMedia(fakeRes, 'seed-photos/1/big.jpg')).resolves.toBeUndefined();
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(1024 * 1024);
    });

    it('sendDownload streams the ZIP as an attachment', async () => {
      await put('exports/3/9.zip', 'zip-bytes', 'exports');
      const res = await request(app)
        .get('/download/exports/3/9.zip')
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toBe('attachment; filename="vernal-export-2026-10-28.zip"');
      expect((res.body as Buffer).toString()).toBe('zip-bytes');
    });
  });

  describe('checkReady', () => {
    it('creates both area folders and leaves no probe behind', async () => {
      await local.checkReady();
      expect((await fs.readdir(dir)).sort()).toEqual(['exports', 'media']);
      expect(await fs.readdir(path.join(dir, 'media'))).toEqual([]);
      expect(await fs.readdir(path.join(dir, 'exports'))).toEqual([]);
    });

    it('fails with a ConfigError when MEDIA_DIR is unusable', async () => {
      // A file where the directory should be.
      const file = path.join(dir, 'not-a-dir');
      await fs.writeFile(file, 'x');
      vi.stubEnv('MEDIA_DIR', file);
      await expect(local.checkReady()).rejects.toBeInstanceOf(ConfigError);
    });
  });
});
