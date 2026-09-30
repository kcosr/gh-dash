import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { ProviderKind } from '../../../shared/api';
import { branchRef, threadsMarkdown } from '../../../shared/comment-markdown';
import { PROVIDERS, refText } from '../../../shared/provider';
import {
  type CommentDeps,
  createBranchThread,
  createCommitThread,
  createPrThread,
  deleteComment,
  deleteThread,
  editComment,
  getThread,
  listTargetThreads,
  type NewBranchThread,
  type NewPrThread,
  type NewThread,
  parseBranch,
  parseId,
  parseOid,
  providerKindOf,
  reply,
  replyBody,
  resolveTarget,
  selfPrincipal,
  setThreadStatus,
  statusBody,
  type TargetRef,
} from '../../services/comments';
import { queryThreads } from '../../services/threads';
import type { AppDeps } from '../app';
import { HttpError, jsonBody, parseWith } from '../http';
import { threadQuerySchema } from '../scope';

const listQuery = z.object({ format: z.enum(['json', 'md']).optional() });

function prNumberParam(c: Context): number {
  const number = Number(c.req.param('number'));
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Invalid PR number');
  return number;
}

/**
 * The comment routes: services/comments.ts does the work, as the dashboard's own user (every HTTP request is; agents
 * write through MCP, as themselves).
 */
export function commentRoutes({ db, config, bus }: AppDeps): Hono {
  const r = new Hono();
  const deps: CommentDeps = { db, bus };
  const me = () => selfPrincipal(db);

  const list = (c: Context, target: TargetRef, title: (kind: ProviderKind) => string) => {
    const { repoId } = resolveTarget(deps, target);
    const { format } = parseWith(listQuery, c.req.query());
    const items = listTargetThreads(deps, target);
    if (format === 'md') {
      const kind = providerKindOf(db, repoId);
      // A PR's list and a branch's hold their branch group: threads made elsewhere in it say where.
      const own = { kind: target.kind, number: target.kind === 'pr' ? target.number : null };
      const md = threadsMarkdown(items, { title: title(kind), provider: PROVIDERS[kind], target: own });
      return c.body(md, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    }
    return c.json({ items });
  };

  // Routes with a body read it first (after checking the URL's own syntax), then call the service, which finds the
  // target and writes with no await in between: a thread, comment or repo may go while a slow body is still arriving.
  // The service validates the body it is given.

  r.get('/prs/:repo/:number/threads', (c) => {
    const number = prNumberParam(c);
    const repo = c.req.param('repo')!;
    return list(c, { repo, kind: 'pr', number }, (kind) => refText(kind, repo, number, 'pr'));
  });

  r.post('/prs/:repo/:number/threads', async (c) => {
    const number = prNumberParam(c);
    const body = (await jsonBody(c)) as NewPrThread;
    return c.json(createPrThread(deps, me(), c.req.param('repo')!, number, body));
  });

  // Commits need not be synced (like their diffs): PR branch commits aren't.
  r.get('/commits/:repo/:oid/threads', (c) => {
    const oid = parseOid(c.req.param('oid')!);
    const repo = c.req.param('repo')!;
    return list(c, { repo, kind: 'commit', oid }, () => `${repo}@${oid.slice(0, 7)}`);
  });

  r.post('/commits/:repo/:oid/threads', async (c) => {
    const oid = parseOid(c.req.param('oid')!);
    const body = (await jsonBody(c)) as NewThread;
    return c.json(createCommitThread(deps, me(), c.req.param('repo')!, oid, body));
  });

  // :branch is URL-encoded as one segment, as :repo is (fix%2Flogin), and comes decoded. Neither route asks the code
  // host: a branch's threads outlive the branch, as a PR's outlive its row.
  r.get('/branches/:repo/:branch/threads', (c) => {
    const branch = parseBranch(c.req.param('branch')!);
    const repo = c.req.param('repo')!;
    return list(c, { repo, kind: 'branch', branch }, () => branchRef(repo, branch));
  });

  r.post('/branches/:repo/:branch/threads', async (c) => {
    const branch = parseBranch(c.req.param('branch')!);
    const body = (await jsonBody(c)) as NewBranchThread;
    return c.json(createBranchThread(deps, me(), c.req.param('repo')!, branch, body));
  });

  // Every thread in scope, across PRs, branches and commits (the scope hides removed repos, as /prs does).
  r.get('/threads', (c) => {
    const out = queryThreads({ db, config }, parseWith(threadQuerySchema, c.req.query()));
    if (out.format === 'json') return c.json(out.body);
    return c.body(out.text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  // By id: the service checks the thread's repo, as the key-based routes do by resolving the key.
  r.get('/threads/:id', (c) => c.json(getThread(deps, parseId(c.req.param('id')))));

  r.patch('/threads/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const { status } = parseWith(statusBody, await jsonBody(c));
    return c.json(setThreadStatus(deps, me(), id, status));
  });

  r.delete('/threads/:id', (c) => {
    deleteThread(deps, me(), parseId(c.req.param('id')));
    return c.body(null, 204);
  });

  r.post('/threads/:id/comments', async (c) => {
    const id = parseId(c.req.param('id'));
    const { body } = parseWith(replyBody, await jsonBody(c));
    return c.json(reply(deps, me(), id, body));
  });

  r.patch('/comments/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const { body } = parseWith(replyBody, await jsonBody(c));
    return c.json(editComment(deps, me(), id, body));
  });

  // The first comment's author is the thread's: deleting it deletes the thread.
  r.delete('/comments/:id', (c) => c.json(deleteComment(deps, me(), parseId(c.req.param('id')))));

  return r;
}
