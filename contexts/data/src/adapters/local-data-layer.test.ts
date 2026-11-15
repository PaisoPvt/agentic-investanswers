import { describe, expect, it } from 'vitest';

import { s3Config } from './local-data-layer.js';

describe('s3Config', () => {
  it('uses the local MinIO and its credentials by default', () => {
    expect(s3Config({})).toMatchObject({ endpoint: 'http://127.0.0.1:9000', credentials: { accessKeyId: 'minio' } });
  });

  it('uses real S3 with the task role when AIA_S3_ENDPOINT is "aws" (M2-01)', () => {
    expect(s3Config({ AIA_S3_ENDPOINT: 'aws', AIA_S3_SECRET_KEY: 'ignored' })).toEqual({ region: 'us-east-1' });
  });
});
