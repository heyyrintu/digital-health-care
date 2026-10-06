import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Cursor pagination query: `?limit=50&cursor=<opaque>`. */
export const CursorQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).optional(),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

/** Paged response: `{ data, nextCursor }`. `nextCursor` is null on the last page. */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
