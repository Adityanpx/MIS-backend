type PgError = { code?: string; constraint?: string };

/** True when err is a unique-constraint violation (optionally of one specific constraint/index). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgError;
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
