// GET /threads as a plain function, like services/lists.ts: no Hono context, failures as HttpError.

import type { z } from 'zod';
import type { ThreadListResponse } from '../../shared/api';
import { encodeCursor, type threadQuerySchema } from '../api/scope';
import { listThreadItems } from '../db/thread-list';
import { threadListMarkdown } from '../format/markdown';
import { HttpError } from '../lib/errors';
import { type ListReply, page, type QueryDeps, repoKinds, scopedQuery } from './lists';

/**
 * Every comment thread in scope. The cursor is `[sort, updatedAt, id]`: a cursor made under the other sort order would
 * skip or repeat threads, so it is a 400 (the client starts again from the first page when it changes the sort).
 */
export function queryThreads({ db, config }: QueryDeps, q: z.infer<typeof threadQuerySchema>): ListReply<ThreadListResponse> {
  const { scope, ctx } = scopedQuery(db, config, q);
  const filter = { status: q.status ?? 'open', kind: q.kind ?? 'all', sort: q.sort ?? 'recent' };
  if (q.format === 'md') {
    const { items } = listThreadItems(db, ctx, scope, filter, null);
    return { format: 'md', text: threadListMarkdown(items, { ...filter, q: scope.q }, repoKinds(db)) };
  }
  const { limit, after } = page(q, 3);
  if (after && (typeof after[0] !== 'string' || typeof after[1] !== 'string' || typeof after[2] !== 'number')) throw new HttpError(400, 'Invalid cursor');
  if (after && after[0] !== filter.sort) throw new HttpError(400, 'Invalid cursor: it was made under another sort order');
  const res = listThreadItems(db, ctx, scope, filter, { limit, after: after && [after[1]!, after[2]!] });
  return { format: 'json', body: { ...res, nextCursor: encodeCursor(res.nextCursor && [filter.sort, ...res.nextCursor]) } };
}
