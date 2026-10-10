import type { QueryResultRow } from 'pg';
import type { Tx } from './tenant';

export async function many<T extends QueryResultRow>(tx: Tx, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await tx.query<T>(text, params as unknown[]);
  return res.rows;
}
export async function maybeOne<T extends QueryResultRow>(tx: Tx, text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await many<T>(tx, text, params);
  if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`);
  return rows[0];
}
export async function one<T extends QueryResultRow>(tx: Tx, text: string, params: unknown[] = []): Promise<T> {
  const row = await maybeOne<T>(tx, text, params);
  if (!row) throw new Error('Expected exactly one row, got 0');
  return row;
}
export async function exec(tx: Tx, text: string, params: unknown[] = []): Promise<number> {
  const res = await tx.query(text, params as unknown[]);
  return res.rowCount ?? 0;
}

/**
 * Builds "col1 = $n, col2 = $n+1" for the entries that are not undefined (PATCH semantics: null clears a column).
 * Column names come from code only, never from user input. Pass jsonb values already JSON.stringify'd.
 */
export function setClause(fields: Record<string, unknown>, startIndex: number): { sql: string; values: unknown[] } {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  return {
    sql: entries.map(([col], i) => `${col} = $${startIndex + i}`).join(', '),
    values: entries.map(([, v]) => v),
  };
}
