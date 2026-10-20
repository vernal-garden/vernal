import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendMock, getSignedUrlMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
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
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  uploadToR2,
  getPresignedUploadUrl,
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
} from './r2';

const R2_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  R2_PUBLIC_BASE_URL: 'https://cdn.example.com/',
  R2_EXPORTS_BUCKET_NAME: 'test-exports',
};

describe('r2', () => {
  beforeEach(() => {
    Object.assign(process.env, R2_ENV);
    sendMock.mockReset().mockResolvedValue({});
    getSignedUrlMock.mockReset().mockResolvedValue('https://signed.example.com/url');
  });

  afterEach(() => {
    for (const key of Object.keys(R2_ENV)) delete process.env[key];
  });

  it('uploadToR2 sends PutObjectCommand and returns the public URL', async () => {
    const url = await uploadToR2('photos/a.png', Buffer.from('x'), 'image/png');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'photos/a.png',
      ContentType: 'image/png',
    });
    expect(url).toBe('https://cdn.example.com/photos/a.png');
  });

  it('getPresignedUploadUrl signs a PutObjectCommand', async () => {
    const url = await getPresignedUploadUrl('uploads/b.jpg', 'image/jpeg', 1234);

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = getSignedUrlMock.mock.calls[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'uploads/b.jpg',
      ContentType: 'image/jpeg',
      ContentLength: 1234,
    });
    expect(opts.expiresIn).toBe(300);
    expect(opts.signableHeaders).toBeInstanceOf(Set);
    expect(opts.signableHeaders.has('content-type')).toBe(true);
    expect(opts.signableHeaders.has('content-length')).toBe(true);
    expect(typeof url).toBe('string');
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
