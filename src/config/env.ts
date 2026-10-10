import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_ENV: z.string().default('local'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_API_URL: z.string().url(),
  PUBLIC_WEB_URL: z.string().url(),
  PUBLIC_ADMIN_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  DATABASE_URL: z.string().min(1),
  ADMIN_DATABASE_URL: z.string().min(1),
  DB_SSL: z.enum(['require', 'disable']).default('disable'),
  DB_SSL_CA: z.string().optional(),
  DB_POOL_APP_MAX: z.coerce.number().int().min(1).max(50).default(8),
  DB_POOL_ADMIN_MAX: z.coerce.number().int().min(1).max(20).default(4),

  JWT_CLIENT_SECRET: z.string().min(32),
  JWT_ADMIN_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS_CLIENT: z.coerce.number().int().min(1).max(30).default(7),
  REFRESH_TTL_HOURS_ADMIN: z.coerce.number().int().min(1).max(72).default(12),
  COOKIE_SECURE: bool,
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64'),
  ADMIN_IP_ALLOWLIST: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])),

  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.storage'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),

  EMAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().min(3),
  EMAIL_REPLY_TO: z.string().optional(),

  CRON_SECRET: z.string().min(32),
  SENTRY_DSN: z.string().optional(),

  JOBS_MODE: z.enum(['boss', 'inline', 'off']).default('boss'), // inline = run jobs in-process right after commit (tests)
  PDF_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  PDF_MAX_PER_BROWSER: z.coerce.number().int().min(1).max(500).default(50),
  RAZORPAY_DRIVER: z.enum(['live', 'fake', 'off']).default('live'), // fake = tests; off = no links (dev without keys)
  RAZORPAY_API_BASE: z.string().url().default('https://api.razorpay.com/v1'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;

if (env.STORAGE_DRIVER === 'r2' && !(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET)) {
  // eslint-disable-next-line no-console
  console.error('STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
  process.exit(1);
}
if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
  // eslint-disable-next-line no-console
  console.error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true (browsers reject it otherwise)');
  process.exit(1);
}
if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
  // eslint-disable-next-line no-console
  console.error('EMAIL_DRIVER=resend requires RESEND_API_KEY');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && (env.EMAIL_DRIVER !== 'resend' || env.STORAGE_DRIVER !== 'r2')) {
  // eslint-disable-next-line no-console
  console.error('Production requires EMAIL_DRIVER=resend and STORAGE_DRIVER=r2 (console/local drivers are for dev/test only)');
  process.exit(1);
}
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
