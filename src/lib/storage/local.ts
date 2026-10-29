import fs, { type Dirent } from 'fs';
import fsp, { type FileHandle } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import type { Response } from 'express';
import { ConfigError } from '../serverConfig';
import type { Area, StorageDriver } from './index';

// MEDIA_STORAGE=local: every object is a file under MEDIA_DIR, in
// <MEDIA_DIR>/media or <MEDIA_DIR>/exports. Keys use '/' like S3 keys.
// MEDIA_DIR is read on each call (it is validated once at startup), so tests
// can point it at a fresh temp directory.

// In-flight writes; listings skip them.
const TMP_MARK = '.tmp-';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function root(): string {
  const dir = process.env.MEDIA_DIR?.trim();
  if (!dir) throw new ConfigError('MEDIA_DIR is not set. It is required when MEDIA_STORAGE=local.');
  return path.resolve(dir);
}

function areaDir(area: Area): string {
  return path.join(root(), area);
}

function isInside(dir: string, target: string, allowSelf: boolean): boolean {
  const rel = path.relative(dir, target);
  if (rel === '') return allowSelf;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The file behind a key. Throws for anything that could leave its area.
function resolve(area: Area, key: string, allowAreaRoot = false): string {
  if ((!key && !allowAreaRoot) || key.includes('..') || key.includes('\\') || key.startsWith('/')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  const dir = areaDir(area);
  const file = path.resolve(dir, key);
  if (!isInside(dir, file, allowAreaRoot)) throw new Error(`Invalid storage key: ${key}`);
  return file;
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

const isMissing = (err: unknown) => code(err) === 'ENOENT' || code(err) === 'ENOTDIR';

// Writes to a temp file beside the target, then renames it into place, so a
// reader never sees half a file.
async function writeAtomically(file: string, write: (tmp: string) => Promise<void>): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}${TMP_MARK}${randomUUID()}`;
  try {
    await write(tmp);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// The folder a prefix lists from ('seed-photos/5/' → seed-photos/5) and the
// keys found there, '/'-separated and relative to the area.
function prefixDir(area: Area, prefix: string): { dir: string; base: string } {
  const base = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  return { dir: resolve(area, base, true), base };
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

async function walk(dir: string, base: string, out: { key: string; file: string }[]): Promise<void> {
  for (const entry of await readDir(dir)) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file, `${base}${entry.name}/`, out);
    else if (entry.isFile() && !entry.name.includes(TMP_MARK)) out.push({ key: `${base}${entry.name}`, file });
  }
}

async function filesUnder(area: Area, prefix: string): Promise<{ key: string; file: string }[]> {
  const { dir, base } = prefixDir(area, prefix);
  const found: { key: string; file: string }[] = [];
  await walk(dir, base, found);
  return found.filter((f) => f.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Opens a file for streaming with its size, or null when there is no file
// there. On POSIX a directory opens fine, so a non-file counts as missing too.
async function open(file: string): Promise<{ handle: FileHandle; size: number } | null> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (err) {
    if (isMissing(err) || code(err) === 'EISDIR') return null;
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (stats.isFile()) return { handle, size: stats.size };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
  await handle.close().catch(() => undefined);
  return null;
}

// Errors that only mean the client went away (a cancelled image load, a
// navigation): the response ends early, which is not a server failure.
const CLIENT_GONE = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED']);

function clientWentAway(err: unknown, res: Response): boolean {
  const c = code(err);
  if (c === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  return c !== undefined && CLIENT_GONE.has(c) && res.destroyed;
}

async function sendFile(res: Response, file: string, headers: Record<string, string>): Promise<void> {
  const opened = await open(file);
  if (!opened) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { handle, size } = opened;
  try {
    res.set({ ...headers, 'Content-Length': String(size) });
    res.status(200);
    await pipeline(handle.createReadStream(), res);
  } catch (err) {
    if (!clientWentAway(err, res)) throw err;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const localDriver: StorageDriver = {
  async put(area, key, body, _contentType) {
    const file = resolve(area, key);
    await writeAtomically(file, (tmp) => fsp.writeFile(tmp, body));
  },

  async putStream(area, key, body, _contentType) {
    const file = resolve(area, key);
    await writeAtomically(file, (tmp) => pipeline(body, fs.createWriteStream(tmp)));
  },

  async getStream(area, key) {
    const opened = await open(resolve(area, key));
    return opened ? opened.handle.createReadStream() : null;
  },

  async remove(area, key) {
    try {
      await fsp.unlink(resolve(area, key));
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  },

  async removePrefix(area, prefix) {
    if (!prefix.endsWith('/')) throw new Error(`Storage prefix must end with /: ${prefix}`);
    await fsp.rm(resolve(area, prefix), { recursive: true, force: true });
  },

  async listFolders(area, prefix) {
    const { dir, base } = prefixDir(area, prefix);
    return (await readDir(dir))
      .filter((e) => e.isDirectory())
      .map((e) => `${base}${e.name}/`)
      .filter((folder) => folder.startsWith(prefix))
      .sort();
  },

  async listKeys(area, prefix) {
    return (await filesUnder(area, prefix)).map((f) => f.key);
  },

  async listObjects(area, prefix) {
    const objects: { key: string; lastModified: Date | null }[] = [];
    for (const { key, file } of await filesUnder(area, prefix)) {
      try {
        objects.push({ key, lastModified: (await fsp.stat(file)).mtime });
      } catch (err) {
        if (!isMissing(err)) throw err; // removed since the listing
      }
    }
    return objects;
  },

  async sendMedia(res, key) {
    const file = resolve('media', key);
    await sendFile(res, file, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    });
  },

  // ttlSeconds is unused: the file streams through this request, so there is
  // no link that could outlive it.
  async sendDownload(res, area, key, filename, _ttlSeconds) {
    await sendFile(res, resolve(area, key), {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"`,
    });
  },

  async checkReady() {
    const dir = root();
    try {
      for (const area of ['media', 'exports'] as const) {
        const areaPath = path.join(dir, area);
        await fsp.mkdir(areaPath, { recursive: true });
        const probe = path.join(areaPath, `${TMP_MARK}probe-${randomUUID()}`);
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`MEDIA_DIR (${dir}) is not usable: ${reason}`);
    }
  },
};
