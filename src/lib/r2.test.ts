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
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { uploadToR2, getPresignedUploadUrl, getPresignedDownloadUrl, deleteFromR2 } from './r2';

const R2_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  R2_PUBLIC_BASE_URL: 'https://cdn.example.com/',
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
    const url = await getPresignedUploadUrl('uploads/b.jpg', 'image/jpeg');

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = getSignedUrlMock.mock.calls[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'uploads/b.jpg',
      ContentType: 'image/jpeg',
    });
    expect(opts).toEqual({ expiresIn: 300 });
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
});
