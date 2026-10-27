import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendMock, getSignedUrlMock, uploadCtorMock, uploadDoneMock, uploadAbortMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  uploadCtorMock: vi.fn(),
  uploadDoneMock: vi.fn(),
  uploadAbortMock: vi.fn(),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class Upload {
    constructor(opts: Record<string, unknown>) {
      uploadCtorMock(opts);
    }
    done = uploadDoneMock;
    abort = uploadAbortMock;
  },
}));

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
    PutObjectCommand: class PutObjectCommand extends FakeCommand {},
    GetObjectCommand: class GetObjectCommand extends FakeCommand {},
    DeleteObjectCommand: class DeleteObjectCommand extends FakeCommand {},
    ListObjectsV2Command: class ListObjectsV2Command extends FakeCommand {},
    DeleteObjectsCommand: class DeleteObjectsCommand extends FakeCommand {},
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { PassThrough } from 'stream';
import {
  uploadToR2,
  uploadStreamToR2,
  resetR2Client,
  getPresignedDownloadUrl,
  deleteFromR2,
  exportsBucket,
  deletePrefixFromR2,
  listFolders,
  listKeys,
  seedPhotoFolder,
  harvestPhotoFolder,
  gardenThumbnailFolder,
  exportFolder,
  getMediaRedirectUrl,
  getMediaObject,
} from './r2';

const R2_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  R2_EXPORTS_BUCKET_NAME: 'test-exports',
};

describe('r2', () => {
  beforeEach(() => {
    Object.assign(process.env, R2_ENV);
    resetR2Client();
    vi.mocked(S3Client).mockClear();
    sendMock.mockReset().mockResolvedValue({});
    getSignedUrlMock.mockReset().mockResolvedValue('https://signed.example.com/url');
    uploadCtorMock.mockReset();
    uploadDoneMock.mockReset().mockResolvedValue({});
    uploadAbortMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const key of Object.keys(R2_ENV)) delete process.env[key];
  });

  it('uploadToR2 sends PutObjectCommand', async () => {
    await uploadToR2('photos/a.png', Buffer.from('x'), 'image/png');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'photos/a.png',
      ContentType: 'image/png',
    });
  });

  describe('uploadStreamToR2', () => {
    it('streams the body to the given bucket in 5 MB parts, one at a time', async () => {
      const body = new PassThrough();
      await uploadStreamToR2('exports/1/2.zip', body, 'application/zip', 'test-exports');

      expect(uploadCtorMock).toHaveBeenCalledTimes(1);
      const opts = uploadCtorMock.mock.calls[0][0];
      expect(opts).toMatchObject({
        params: { Bucket: 'test-exports', Key: 'exports/1/2.zip', Body: body, ContentType: 'application/zip' },
        partSize: 5 * 1024 * 1024,
        queueSize: 1,
      });
      expect(opts.client).toBe(vi.mocked(S3Client).mock.results[0].value);
      expect(uploadDoneMock).toHaveBeenCalledTimes(1);
      expect(uploadAbortMock).not.toHaveBeenCalled();
    });

    it('defaults to R2_BUCKET_NAME', async () => {
      await uploadStreamToR2('k', new PassThrough(), 'text/plain');
      expect(uploadCtorMock.mock.calls[0][0].params.Bucket).toBe('test-bucket');
    });

    it('aborts the upload and rethrows when it fails', async () => {
      uploadDoneMock.mockRejectedValueOnce(new Error('part failed'));
      await expect(
        uploadStreamToR2('k', new PassThrough(), 'application/zip', 'test-exports'),
      ).rejects.toThrow('part failed');
      expect(uploadAbortMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows the upload error even when abort also fails', async () => {
      uploadDoneMock.mockRejectedValueOnce(new Error('part failed'));
      uploadAbortMock.mockRejectedValueOnce(new Error('abort failed'));
      await expect(uploadStreamToR2('k', new PassThrough(), 'application/zip')).rejects.toThrow('part failed');
    });
  });

  it('builds one S3Client and reuses it across calls', async () => {
    await deleteFromR2('a');
    await deleteFromR2('b');
    expect(vi.mocked(S3Client)).toHaveBeenCalledTimes(1);
  });

  it('resetR2Client makes the next call build a new client', async () => {
    await deleteFromR2('a');
    resetR2Client();
    await deleteFromR2('b');
    expect(vi.mocked(S3Client)).toHaveBeenCalledTimes(2);
  });

  it('still throws "R2 not configured" when env is missing, without building a client', async () => {
    delete process.env.R2_ACCESS_KEY_ID;
    await expect(deleteFromR2('a')).rejects.toThrow(/R2 not configured/);
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
  });

  it('getPresignedDownloadUrl signs a GetObjectCommand', async () => {
    const url = await getPresignedDownloadUrl('exports/c.zip');

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = getSignedUrlMock.mock.calls[0];
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 'exports/c.zip' });
    expect(opts).toEqual({ expiresIn: 604800 });
    expect(typeof url).toBe('string');
  });

  it('deleteFromR2 sends DeleteObjectCommand with bucket and key', async () => {
    await deleteFromR2('photos/a.png');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 'photos/a.png' });
  });

  it('uploadToR2 throws a clear error when R2_BUCKET_NAME is missing', async () => {
    delete process.env.R2_BUCKET_NAME;

    await expect(uploadToR2('k', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /R2 not configured.*R2_BUCKET_NAME/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('uploadToR2 sends PutObjectCommand to the given bucket', async () => {
    await uploadToR2('exports/1/2.zip', Buffer.from('x'), 'application/zip', 'test-exports');

    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'test-exports',
      Key: 'exports/1/2.zip',
      ContentType: 'application/zip',
    });
  });

  it('getPresignedDownloadUrl signs a GetObjectCommand for the given bucket', async () => {
    await getPresignedDownloadUrl('exports/1/2.zip', 604800, 'test-exports');

    const [, cmd, opts] = getSignedUrlMock.mock.calls[0];
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'test-exports', Key: 'exports/1/2.zip' });
    expect(opts).toEqual({ expiresIn: 604800 });
  });

  it('deleteFromR2 sends DeleteObjectCommand for the given bucket', async () => {
    await deleteFromR2('exports/1/2.zip', 'test-exports');

    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'test-exports', Key: 'exports/1/2.zip' });
  });

  describe('getMediaRedirectUrl', () => {
    it('signs a 2-hour GET on the photo bucket with private caching', async () => {
      await getMediaRedirectUrl('seed-photos/1/a.jpg', new Date('2026-10-27T15:42:10Z'));

      const [, cmd, opts] = getSignedUrlMock.mock.calls[0];
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect(cmd.input).toEqual({
        Bucket: 'test-bucket',
        Key: 'seed-photos/1/a.jpg',
        ResponseCacheControl: 'private, max-age=3600',
      });
      expect(opts).toEqual({ expiresIn: 7200, signingDate: new Date('2026-10-27T15:00:00Z') });
    });

    it('returns the same URL within an hour and a new one the next hour', async () => {
      getSignedUrlMock.mockImplementation(
        async (_c: unknown, _cmd: unknown, o: { signingDate: Date }) => `https://signed/${o.signingDate.toISOString()}`,
      );
      const a = await getMediaRedirectUrl('k', new Date('2026-10-27T15:01:00Z'));
      const b = await getMediaRedirectUrl('k', new Date('2026-10-27T15:59:59Z'));
      const c = await getMediaRedirectUrl('k', new Date('2026-10-27T16:00:00Z'));
      expect(a).toBe(b);
      expect(c).not.toBe(a);
    });
  });

  describe('getMediaObject', () => {
    it('returns the body stream from the photo bucket', async () => {
      const body = new PassThrough();
      sendMock.mockResolvedValueOnce({ Body: body });
      await expect(getMediaObject('seed-photos/1/a.jpg')).resolves.toBe(body);
      const cmd = sendMock.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 'seed-photos/1/a.jpg' });
    });

    it('returns null when the object does not exist', async () => {
      sendMock.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
      await expect(getMediaObject('seed-photos/1/a.jpg')).resolves.toBeNull();
    });

    it('rethrows any other error', async () => {
      sendMock.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
      await expect(getMediaObject('seed-photos/1/a.jpg')).rejects.toThrow('denied');
    });
  });

  describe('folders', () => {
    it('builds folder paths with a trailing slash', () => {
      expect(seedPhotoFolder(5)).toBe('seed-photos/5/');
      expect(harvestPhotoFolder('7')).toBe('harvest-photos/7/');
      expect(gardenThumbnailFolder(9)).toBe('garden-thumbnails/9/');
      expect(exportFolder(3)).toBe('exports/3/');
    });

    it('deletePrefixFromR2 rejects a prefix without a trailing slash', async () => {
      await expect(deletePrefixFromR2('seed-photos/5')).rejects.toThrow('must end with /');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('deletePrefixFromR2 pages through the listing and deletes each page', async () => {
      sendMock
        .mockResolvedValueOnce({
          Contents: [{ Key: 'seed-photos/5/a.jpg' }, { Key: 'seed-photos/5/b.jpg' }],
          IsTruncated: true,
          NextContinuationToken: 'tok',
        })
        .mockResolvedValueOnce({}) // DeleteObjects, page 1
        .mockResolvedValueOnce({ Contents: [{ Key: 'seed-photos/5/c.jpg' }], IsTruncated: false })
        .mockResolvedValueOnce({}); // DeleteObjects, page 2

      await deletePrefixFromR2('seed-photos/5/');

      const cmds = sendMock.mock.calls.map((c) => c[0]);
      expect(cmds[0]).toBeInstanceOf(ListObjectsV2Command);
      expect(cmds[0].input).toMatchObject({ Bucket: 'test-bucket', Prefix: 'seed-photos/5/' });
      expect(cmds[1]).toBeInstanceOf(DeleteObjectsCommand);
      expect(cmds[1].input).toMatchObject({
        Bucket: 'test-bucket',
        Delete: { Objects: [{ Key: 'seed-photos/5/a.jpg' }, { Key: 'seed-photos/5/b.jpg' }], Quiet: true },
      });
      expect(cmds[2].input).toMatchObject({ ContinuationToken: 'tok' });
      expect(cmds[3].input).toMatchObject({ Delete: { Objects: [{ Key: 'seed-photos/5/c.jpg' }] } });
    });

    it('deletePrefixFromR2 sends no delete for an empty folder', async () => {
      sendMock.mockResolvedValueOnce({ IsTruncated: false });
      await deletePrefixFromR2('seed-photos/5/');
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('deletePrefixFromR2 throws when R2 reports per-key errors', async () => {
      sendMock
        .mockResolvedValueOnce({ Contents: [{ Key: 'seed-photos/5/a.jpg' }], IsTruncated: false })
        .mockResolvedValueOnce({ Errors: [{ Key: 'seed-photos/5/a.jpg', Message: 'nope' }] });
      await expect(deletePrefixFromR2('seed-photos/5/')).rejects.toThrow('1 object(s)');
    });

    it('deletePrefixFromR2 uses the given bucket', async () => {
      sendMock.mockResolvedValueOnce({ IsTruncated: false });
      await deletePrefixFromR2('exports/3/', 'test-exports');
      expect(sendMock.mock.calls[0][0].input).toMatchObject({ Bucket: 'test-exports' });
    });

    it('listFolders returns CommonPrefixes across pages', async () => {
      sendMock
        .mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'seed-photos/1/' }], IsTruncated: true, NextContinuationToken: 't' })
        .mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'seed-photos/2/' }], IsTruncated: false });
      expect(await listFolders('seed-photos/')).toEqual(['seed-photos/1/', 'seed-photos/2/']);
      expect(sendMock.mock.calls[0][0].input).toMatchObject({ Prefix: 'seed-photos/', Delimiter: '/' });
    });

    it('listKeys returns every key under a prefix', async () => {
      sendMock.mockResolvedValueOnce({ Contents: [{ Key: 'exports/3/1.zip' }, { Key: 'exports/3/2.zip' }], IsTruncated: false });
      expect(await listKeys('exports/3/', 'test-exports')).toEqual(['exports/3/1.zip', 'exports/3/2.zip']);
    });
  });

  describe('exportsBucket', () => {
    it('returns R2_EXPORTS_BUCKET_NAME', () => {
      expect(exportsBucket()).toBe('test-exports');
    });

    it('throws when R2_EXPORTS_BUCKET_NAME is missing', () => {
      delete process.env.R2_EXPORTS_BUCKET_NAME;
      expect(() => exportsBucket()).toThrow('R2_EXPORTS_BUCKET_NAME is not set.');
    });

    it('throws when R2_EXPORTS_BUCKET_NAME equals the public R2_BUCKET_NAME', () => {
      process.env.R2_EXPORTS_BUCKET_NAME = 'test-bucket';
      expect(() => exportsBucket()).toThrow(
        'R2_EXPORTS_BUCKET_NAME must be a private bucket, not the public R2_BUCKET_NAME.',
      );
    });
  });
});
