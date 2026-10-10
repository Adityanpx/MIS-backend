import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { badRequest, notFound } from '../../lib/errors';

export interface SignOptions {
  ttlSec?: number;
  downloadName?: string; // set → browser downloads instead of displaying
}
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Streams a local file to storage (multipart on R2). Use for anything that can be large. */
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key under a prefix (e.g. `t/<tenantId>/`). */
  listKeys(prefix: string): Promise<string[]>;
  removeMany(keys: string[]): Promise<void>;
  signedUrl(key: string, opts?: SignOptions): Promise<string>;
}

const KEY_RE = /^(t\/[0-9a-f-]{36}|platform)\/[A-Za-z0-9._\-/ ]+$/;

export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) throw badRequest('INVALID_KEY', 'Invalid file key');
}
/** Builds a tenant-scoped key: t/{tenantId}/part1/part2... */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  return ['t', tenantId, ...parts].join('/');
}
/** A key must belong to the tenant before we sign it (defence in depth on top of RLS). */
export function assertTenantKey(key: string, tenantId: string): void {
  if (!key.startsWith(`t/${tenantId}/`)) throw notFound('File');
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export function contentTypeForKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

// ---------------- local driver (development / test) ----------------
const LOCAL_SIGNING_KEY = crypto.createHash('sha256').update(`local-files:${env.ENCRYPTION_KEY}`).digest();

function localSignature(key: string, exp: number, name: string): string {
  return crypto.createHmac('sha256', LOCAL_SIGNING_KEY).update(`${key}\n${exp}\n${name}`).digest('base64url');
}
export function verifyLocalSignature(key: string, exp: number, name: string, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(localSignature(key, exp, name));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
function localPath(key: string): string {
  assertSafeKey(key);
  const root = path.resolve(env.LOCAL_STORAGE_DIR);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw badRequest('INVALID_KEY', 'Invalid file key');
  return full;
}
export async function readLocalFile(key: string): Promise<Buffer> {
  return fs.readFile(localPath(key));
}

class LocalStorage implements StorageDriver {
  async put(key: string, body: Buffer): Promise<void> {
    const file = localPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  async remove(key: string): Promise<void> {
    await fs.rm(localPath(key), { force: true });
  }
  async signedUrl(key: string, opts: SignOptions = {}): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? env.SIGNED_URL_TTL_SEC);
    const name = opts.downloadName ?? '';
    const q = new URLSearchParams({ key, exp: String(exp), sig: localSignature(key, exp, name) });
    if (name) q.set('name', name);
    return `${env.PUBLIC_API_URL}/api/v1/files/local?${q.toString()}`;
  }
  async putFile(key: string, filePath: string): Promise<void> {
    const file = localPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(filePath, file);
  }
  async listKeys(prefix: string): Promise<string[]> {
    const root = path.resolve(env.LOCAL_STORAGE_DIR);
    const start = path.resolve(root, prefix);
    if (!start.startsWith(root + path.sep)) throw badRequest('INVALID_KEY', 'Invalid prefix');
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Array<import('node:fs').Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // prefix does not exist
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    await walk(start);
    return out.sort();
  }
  async removeMany(keys: string[]): Promise<void> {
    for (const k of keys) await this.remove(k);
  }
}

// ---------------- Cloudflare R2 driver (staging / production) ----------------
class R2Storage implements StorageDriver {
  private readonly s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '' },
  });
  private readonly bucket = env.R2_BUCKET ?? '';

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async signedUrl(key: string, opts: SignOptions = {}): Promise<string> {
    assertSafeKey(key);
    const disposition = opts.downloadName
      ? `attachment; filename="${opts.downloadName.replace(/["\\\r\n]/g, '_')}"`
      : undefined;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition }),
      { expiresIn: opts.ttlSec ?? env.SIGNED_URL_TTL_SEC },
    );
  }
  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    assertSafeKey(key);
    await new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(filePath), ContentType: contentType },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
    }).done();
  }
  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async removeMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      chunk.forEach(assertSafeKey);
      await this.s3.send(new DeleteObjectsCommand({
        Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }));
    }
  }
}

export const storage: StorageDriver = env.STORAGE_DRIVER === 'r2' ? new R2Storage() : new LocalStorage();

/** Signed URL or null; used for optional images such as logos. */
export async function signedUrlOrNull(key: string | null | undefined): Promise<string | null> {
  return key ? storage.signedUrl(key) : null;
}

export const BILLING_PREFIX = 'billing';
export const billingKey = (tenantId: string, ...parts: string[]) => tenantKey(tenantId, BILLING_PREFIX, ...parts);
/** Turns a document number into a safe file name: INV/2026-27/0001 → INV-2026-27-0001 */
export const docFileName = (number: string) => number.replace(/[^A-Za-z0-9-]+/g, '-');
