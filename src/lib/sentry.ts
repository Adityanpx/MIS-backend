import * as Sentry from '@sentry/node';
import { env } from '../config/env';

export const sentryEnabled = !!env.SENTRY_DSN;
export function initSentry(): void {
  if (!sentryEnabled) return;
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.APP_ENV, tracesSampleRate: 0, sendDefaultPii: false });
}
/** Never send request bodies or tokens: only the error and a few ids. */
export function captureError(err: unknown, extra: Record<string, unknown> = {}): void {
  if (sentryEnabled) Sentry.captureException(err, { extra });
}
