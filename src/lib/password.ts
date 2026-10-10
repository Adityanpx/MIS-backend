import argon2 from 'argon2';
import { unprocessable } from './errors';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
let dummyHash: string | undefined;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}
export async function verifyPassword(hash: string | null | undefined, plain: string): Promise<boolean> {
  // Always spend the same time, even when the user does not exist (prevents user enumeration by timing).
  if (!hash) {
    dummyHash ??= await argon2.hash('dummy-password-for-timing', OPTIONS);
    await argon2.verify(dummyHash, plain).catch(() => false);
    return false;
  }
  return argon2.verify(hash, plain).catch(() => false);
}
/** PRD AUTH-03: at least 10 characters, at least one letter and one digit. */
export function assertPasswordPolicy(plain: string): void {
  if (plain.length < 10 || !/[A-Za-z]/.test(plain) || !/\d/.test(plain)) {
    throw unprocessable('WEAK_PASSWORD', 'Password must be at least 10 characters and contain a letter and a number.', {
      field: 'password',
    });
  }
}
