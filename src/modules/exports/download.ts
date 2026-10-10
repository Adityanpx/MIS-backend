import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { readLocalFile } from '../files/storage';

const s3 = env.STORAGE_DRIVER === 'r2'
  ? new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '' } })
  : null;

/** Server-side read (zips, imports). Users never get raw keys: they get signed URLs. */
export async function readStoredFile(key: string): Promise<Buffer> {
  if (!s3) return readLocalFile(key);
  const r = await s3.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}
