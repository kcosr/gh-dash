// list_threads, get_thread: gh-dash's comment threads on PRs and commits, placed on the current diff.

import { z } from 'zod';
import { getThread, threadRepo } from '../../db/comments';
import { HttpError } from '../../lib/errors';
import { repoKinds } from '../../services/lists';
import { idArg } from '../format';
import { placeThreads } from '../placement';
import { targetTitle, threadOut } from '../threads';
import { readTool } from '../tool';

const PLACEMENT_DOC =
  'placement is where the thread is on the current diff (the PR\'s head): line (startLine..endLine; relocated when made ' +
  'on an earlier push and found again by its text), file, target (the whole PR or commit), outdated (its file or lines ' +
  'are gone), or unknown (the diff couldn\'t be fetched).';

export const getThreadTool = readTool({
  name: 'get_thread',
  title: 'Get a comment thread',
  description:
    'One comment thread with its whole conversation. `by` is "me" (you), "you" (the user) or "agent:<name>". The anchor ' +
    'is the revision (commit), file (path), side (new: the head\'s lines, old: the base\'s) and lines it was made on, with ' +
    `their text (snippet). ${PLACEMENT_DOC}`,
  input: z.object({ id: idArg('Thread id') }).strict(),
  run: async ({ id }, { deps, principal, signal }) => {
    const { db } = deps;
    const owner = threadRepo(db, id);
    if (!owner || owner.removed) throw new HttpError(404, `Thread ${id} not found`);
    const t = getThread(db, id)!;
    const placement = (await placeThreads(deps, [t], signal)).get(t.id)!;
    return threadOut(t, principal, { kind: repoKinds(db)(t.repo), title: targetTitle(db, t), placement, comments: true, snippetChars: null });
  },
});
