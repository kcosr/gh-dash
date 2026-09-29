// Threads as tools return them: what they are on, where they are anchored and placed now, and their conversation,
// with authors from the calling agent's side (format.ts byOf).

import type { CommentThread, Principal, ProviderKind } from '../../shared/api';
import type { Db } from '../db/db';
import { byOf, excerpt, targetRef } from './format';
import type { Placement } from './placement';

/** Longest snippet a thread list shows (get_thread shows it whole). */
export const LIST_SNIPPET_CHARS = 400;

/** The PR's title or the commit's headline (a synced PR's commit when the commit itself isn't synced); null if neither. */
export function targetTitle(db: Db, t: Pick<CommentThread, 'repo' | 'kind' | 'number' | 'commitOid'>): string | null {
  const row =
    t.kind === 'pr'
      ? db.get<{ title: string }>('SELECT p.title FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE r.key = ? AND p.number = ?', [t.repo, t.number])
      : (db.get<{ title: string }>('SELECT c.headline AS title FROM commits c JOIN repos r ON r.id = c.repo_id WHERE r.key = ? AND c.oid = ?', [t.repo, t.commitOid]) ??
        db.get<{ title: string }>(
          `SELECT pc.headline AS title FROM pr_commits pc JOIN pull_requests q ON q.id = pc.pr_id JOIN repos r ON r.id = q.repo_id
           WHERE r.key = ? AND pc.oid = ? ORDER BY q.number DESC LIMIT 1`,
          [t.repo, t.commitOid],
        ));
  return row?.title ?? null;
}

export interface ThreadOutOptions {
  kind: ProviderKind;
  title: string | null;
  /** Left out when not looked for (a write's result). */
  placement?: Placement;
  /** The whole conversation (else the last comment only). */
  comments: boolean;
  /** Longest snippet shown; null: all of it. */
  snippetChars: number | null;
}

export function threadOut(t: CommentThread, me: Principal, o: ThreadOutOptions) {
  const target = t.kind === 'pr' ? { kind: 'pr' as const, number: t.number!, title: o.title } : { kind: 'commit' as const, oid: t.commitOid, title: o.title };
  const snippet = t.snippet !== null && o.snippetChars !== null && t.snippet.length > o.snippetChars ? `${t.snippet.slice(0, o.snippetChars)}…` : t.snippet;
  const last = t.comments.at(-1)!;
  return {
    id: t.id,
    repo: t.repo,
    ref: targetRef(o.kind, t.repo, t.kind === 'pr' ? { number: t.number! } : { oid: t.commitOid }),
    target,
    status: t.status,
    resolvedBy: t.resolvedBy ? byOf(t.resolvedBy, me) : null,
    anchor: {
      commit: t.commitOid,
      base: t.baseOid,
      ...(t.path !== null ? { path: t.path } : {}),
      ...(t.side !== null ? { side: t.side, startLine: t.startLine, endLine: t.endLine, snippet } : {}),
    },
    ...(o.placement ? { placement: o.placement } : {}),
    openedBy: byOf(t.comments[0]!.author, me),
    counts: { comments: t.comments.length },
    ...(o.comments
      ? {
          comments: t.comments.map((c) => ({
            id: c.id,
            by: byOf(c.author, me),
            at: c.createdAt,
            ...(c.editedAt ? { editedAt: c.editedAt } : {}),
            body: c.body,
          })),
        }
      : { lastComment: { id: last.id, by: byOf(last.author, me), at: last.createdAt, excerpt: excerpt(last.body) } }),
    updatedAt: t.updatedAt,
  };
}
