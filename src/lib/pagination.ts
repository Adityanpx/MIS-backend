import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().regex(/^-?[a-zA-Z]+$/).optional(),
});
export type Pagination = z.infer<typeof paginationQuery>;

export const toLimitOffset = (p: Pagination) => ({ limit: p.pageSize, offset: (p.page - 1) * p.pageSize });
export const pageMeta = (p: Pagination, total: number) => ({ page: p.page, pageSize: p.pageSize, total });

/** Map a whitelisted sort key to a SQL ORDER BY clause. Unknown keys fall back to the default. */
export function orderBy(sort: string | undefined, allowed: Record<string, string>, fallback: string): string {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const col = allowed[desc ? sort.slice(1) : sort];
  return col ? `${col} ${desc ? 'DESC' : 'ASC'}` : fallback;
}
