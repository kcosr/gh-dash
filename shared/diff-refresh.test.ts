import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { Diff } from './api';
import { qk, refreshDiff } from '../web/src/api/hooks';

const diff = (headOid: string): Diff => ({
  kind: 'pr', repo: 'gh-dash', number: 2, title: 'T', baseOid: 'b'.repeat(40), headOid, files: [],
  totalFiles: 0, additions: 0, deletions: 0, fetchedAt: '2026-09-28T00:00:00Z', url: 'https://github.com/o/gh-dash/pull/2/files',
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('refreshDiff', () => {
  it("keeps a forced refresh when the reopening revalidation answers later with the older head", async () => {
    const qc = new QueryClient();
    const id = 'gh-dash#2';
    qc.setQueryData(qk.diff(id), diff('a'.repeat(40)));
    // Reopening revalidates in the background; its (older) answer is still on its way.
    const old = deferred<Diff>();
    const reopening = qc.fetchQuery({ queryKey: qk.diff(id), queryFn: () => old.promise, staleTime: 0 }).catch(() => null);

    const fresh = diff('c'.repeat(40));
    await expect(refreshDiff(qc, id, async (_id, refresh) => (expect(refresh).toBe(true), fresh))).resolves.toBe(fresh);
    old.resolve(diff('a'.repeat(40)));
    await reopening;

    expect(qc.getQueryData<Diff>(qk.diff(id))?.headOid).toBe('c'.repeat(40));
  });
});
