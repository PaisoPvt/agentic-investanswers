import { describe, expect, it } from 'vitest';

import { s3Config } from './stores.js';

describe('s3Config', () => {
  it('uses the local MinIO and its credentials by default', () => {
    expect(s3Config({})).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      credentials: { accessKeyId: 'minio', secretAccessKey: 'minio12345' },
    });
  });

  it('uses real S3 with the task role when AIA_S3_ENDPOINT is "aws" (M2-01)', () => {
    expect(s3Config({ AIA_S3_ENDPOINT: 'aws', AIA_S3_REGION: 'us-east-1', AIA_S3_ACCESS_KEY: 'ignored' })).toEqual({ region: 'us-east-1' });
  });
});
