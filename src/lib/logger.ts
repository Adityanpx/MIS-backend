import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { app: 'ommis-api', env: env.APP_ENV },
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.password', '*.passwordHash', '*.token', '*.refreshToken', '*.accessToken',
      '*.totpSecret', '*.secret', '*.code',
    ],
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
});
