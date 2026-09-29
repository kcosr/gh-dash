import { describe, expect, it } from 'vitest';
import type { CommentThread, ThreadListResponse } from '../../shared/api';
import { loadConfig } from '../config';
import { createThread, getPrincipal, SELF_PRINCIPAL_ID, type ThreadTarget } from '../db/comments';
import type { Db } from '../db/db';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { GITLAB_HOST, seedDb, seedGitLab } from '../test/seed';
import { testTokens } from '../test/tokens';
import { createApp } from './app';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const COMMIT = 'C'.repeat(40);

function makeApp(db: Db = seedDb()) {
  const config = { ...loadConfig({}), webDir: '/nonexistent' };
  const tokens = testTokens();
  const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
  const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources: new GitHubDiffSources({ tokens }), log: () => {} });
  const app = createApp({ db, config, sync, diffs, tokens });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://localhost/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = CommentThread>(method: string, path: string, body?: unknown) => {
    const res = await send(method, path, body);
    return { status: res.status, body: (await res.json()) as T };
  };
  /**
   * Sends a request whose JSON body is held back until `meanwhile` has run, the handler being parked on it by then:
   * whatever `meanwhile` changes happens while the route awaits the body. With a Content-Length, as browsers and curl
   * send, bodyLimit streams the body through to the route instead of reading it first.
   */
  const sendLate = async (method: string, path: string, body: unknown, meanwhile: () => void) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    let release!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(bytes);
          controller.close();
        };
      },
    });
    const res = app.request(`http://localhost/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) }, body: stream, duplex: 'half',
    } as RequestInit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    meanwhile();
    release();
    return res;
  };
  return { app, db, send, json, sendLate };
}

const lineThread = { commitOid: HEAD, baseOid: BASE, path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, snippet: 'a\nb', body: 'Why?' };

describe('comment threads API', () => {
  it('creates, lists, replies to, edits, resolves and deletes threads', async () => {
    const { send, json } = makeApp();
    const created = await json('POST', '/prs/app/2/threads', lineThread);
    expect(created.status).toBe(200);
    const t = created.body;
    expect(t).toMatchObject({
      kind: 'pr', repo: 'alice/app', number: 2, commitOid: HEAD, baseOid: BASE, path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4,
      snippet: 'a\nb', status: 'open', comments: [{ author: { id: 1, kind: 'self', name: 'You' }, body: 'Why?', editedAt: null }],
    });
    const general = (await json('POST', '/prs/app/2/threads', { commitOid: HEAD, body: 'Overall fine.' })).body;
    expect(general).toMatchObject({ path: null, side: null, baseOid: null });

    const replied = (await json('POST', `/threads/${t.id}/comments`, { body: 'Because.' })).body;
    expect(replied.comments.map((c) => c.body)).toEqual(['Why?', 'Because.']);
    const edited = (await json('PATCH', `/comments/${replied.comments[1]!.id}`, { body: 'Because!' })).body;
    expect(edited.comments[1]).toMatchObject({ body: 'Because!', editedAt: expect.any(String) });
    expect((await json('PATCH', `/threads/${t.id}`, { status: 'resolved' })).body).toMatchObject({ status: 'resolved', resolvedAt: expect.any(String) });
    expect((await json('GET', `/threads/${t.id}`)).body).toMatchObject({ status: 'resolved', comments: [{}, { body: 'Because!' }] });

    const listed = (await json<{ items: CommentThread[] }>('GET', '/prs/app/2/threads')).body;
    expect(listed.items.map((x) => x.id)).toEqual([t.id, general.id]);
    expect((await json<{ items: CommentThread[] }>('GET', '/prs/app/3/threads')).body.items).toEqual([]);

    // Deleting a reply keeps the thread; deleting the first comment deletes it.
    expect((await json<{ thread: CommentThread | null }>('DELETE', `/comments/${edited.comments[1]!.id}`)).body.thread!.comments).toHaveLength(1);
    expect((await json('DELETE', `/comments/${t.comments[0]!.id}`)).body).toEqual({ thread: null });
    expect((await send('GET', `/threads/${t.id}`)).status).toBe(404);
    expect((await send('DELETE', `/threads/${general.id}`)).status).toBe(204);
    expect((await json<{ items: CommentThread[] }>('GET', '/prs/app/2/threads')).body.items).toEqual([]);
  });

  it('keeps commit threads on their commit, synced or not', async () => {
    const { json } = makeApp();
    const t = await json('POST', `/commits/app/${COMMIT}/threads`, { baseOid: BASE, path: 'x.ts', body: 'File note' });
    expect(t.body).toMatchObject({ kind: 'commit', number: null, commitOid: COMMIT.toLowerCase(), baseOid: BASE, path: 'x.ts', side: null });
    // Sending the commit's own oid is fine; another isn't.
    expect((await json('POST', `/commits/app/${COMMIT}/threads`, { commitOid: COMMIT.toLowerCase(), body: 'Same' })).status).toBe(200);
    expect((await json('POST', `/commits/app/${COMMIT}/threads`, { commitOid: HEAD, body: 'Other' })).status).toBe(400);
    const listed = await json<{ items: CommentThread[] }>('GET', `/commits/app/${COMMIT.toLowerCase()}/threads`);
    expect(listed.body.items.map((x) => x.comments[0]!.body)).toEqual(['File note', 'Same']);
    expect((await json<{ items: CommentThread[] }>('GET', `/prs/app/2/threads`)).body.items).toEqual([]);
  });

  it("keys a GitLab merge request's threads by repo and iid, and words its Markdown as GitLab does", async () => {
    const db = seedDb();
    seedGitLab(db);
    const { json, send } = makeApp(db);
    const key = encodeURIComponent(`${GITLAB_HOST}/platform/app`);
    const t = await json('POST', `/prs/${key}/2/threads`, lineThread);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ kind: 'pr', repo: `${GITLAB_HOST}/platform/app`, number: 2 });
    await json('POST', `/prs/${key}/2/threads`, { commitOid: HEAD, body: 'Overall fine.' });
    // The GitHub repo with the same path and number keeps its own (none).
    expect((await json<{ items: CommentThread[] }>('GET', '/prs/app/2/threads')).body.items).toEqual([]);
    expect((await json<{ items: CommentThread[] }>('GET', `/prs/${key}/2/threads`)).body.items).toHaveLength(2);
    const md = await (await send('GET', `/prs/${key}/2/threads?format=md`)).text();
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual([`# ${GITLAB_HOST}/platform/app!2`, '### Merge request', '### `src/a.ts` lines 3–4 (new)']);
    // The MR list counts them, as the PR list does.
    const range = `from=2026-09-01&to=2026-09-30&tz=UTC&repos=${key}`;
    const items = (await json<{ items: { id: string; comments: unknown }[] }>('GET', `/prs?${range}`)).body.items;
    expect(items.find((p) => p.id === `${GITLAB_HOST}/platform/app#2`)?.comments).toEqual({ threads: 2, unresolved: 2 });
    // GitHub's Markdown is unchanged.
    await json('POST', '/prs/app/2/threads', { commitOid: HEAD, body: 'Overall fine.' });
    const gh = await (await send('GET', '/prs/app/2/threads?format=md')).text();
    expect(gh.split('\n').filter((l) => l.startsWith('#'))).toEqual(['# app#2', '### Pull request']);
  });

  it('takes the 64-character SHAs of a SHA-256 repository (GitLab can host those)', async () => {
    const { json } = makeApp();
    const sha256 = 'd'.repeat(64);
    const t = await json('POST', `/commits/app/${sha256}/threads`, { baseOid: 'e'.repeat(64), body: 'Note' });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ kind: 'commit', commitOid: sha256, baseOid: 'e'.repeat(64) });
    expect((await json<{ items: CommentThread[] }>('GET', `/commits/app/${sha256}/threads`)).body.items).toHaveLength(1);
    const line = await json('POST', '/prs/app/2/threads', { ...lineThread, commitOid: 'f'.repeat(64), baseOid: null });
    expect(line.status).toBe(200);
    for (const bad of ['d'.repeat(63), 'd'.repeat(65), 'd'.repeat(41)]) {
      expect((await json('POST', `/commits/app/${bad}/threads`, { body: 'x' })).status, bad).toBe(400);
    }
  });

  it('validates targets, anchors and bodies', async () => {
    const { send } = makeApp();
    const post = async (path: string, body: unknown) => {
      const res = await send('POST', path, body);
      return { status: res.status, error: res.status === 200 ? null : ((await res.json()) as { error: string }).error };
    };
    expect((await post('/prs/nope/2/threads', lineThread)).status).toBe(404);
    expect((await post('/prs/old/1/threads', lineThread)).status).toBe(200); // archived repos are still repos
    expect(await post('/prs/app/99/threads', lineThread)).toEqual({ status: 404, error: 'Pull request not found' });
    expect((await post('/prs/app/0/threads', lineThread)).status).toBe(400);
    expect(await post('/commits/app/abc1234/threads', { body: 'x' })).toEqual({ status: 400, error: 'Invalid oid: expected a full commit SHA (40 or 64 characters)' });

    const bad: [Record<string, unknown>, string][] = [
      [{ commitOid: undefined }, 'commitOid'],
      [{ commitOid: 'abc1234' }, 'commitOid: expected a full commit SHA (40 or 64 characters)'],
      [{ body: '  \n ' }, 'body: must not be empty'],
      [{ body: 'x'.repeat(65_537) }, 'body'],
      [{ path: null }, 'a line thread needs a path'],
      [{ path: '../etc/passwd' }, 'path: must be a file path in the repository'],
      [{ path: 'a//b' }, 'path'],
      [{ side: null }, 'startLine, endLine and snippet need a side'],
      [{ side: 'both' }, 'side'],
      [{ snippet: null }, 'a line thread needs startLine, endLine and snippet'],
      [{ startLine: 0 }, 'startLine'],
      [{ startLine: 1.5 }, 'startLine'],
      [{ startLine: 5 }, 'endLine must not be before startLine'],
      [{ snippet: 'a' }, 'snippet must hold the anchored lines'],
      [{ startLine: 1, endLine: 1001, snippet: 'x\n'.repeat(1000) + 'x' }, 'a thread spans at most 1000 lines'],
      [{ extra: 1 }, 'extra'],
    ];
    for (const [over, message] of bad) {
      const res = await post('/prs/app/2/threads', { ...lineThread, ...over });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.error, JSON.stringify(over)).toContain(message);
    }
    expect((await post('/prs/app/2/threads', { ...lineThread, startLine: 1, endLine: 1000, snippet: 'x\n'.repeat(999) + 'x' })).status).toBe(200);
    // A file thread: a path and nothing else.
    expect((await post('/prs/app/2/threads', { commitOid: HEAD, path: 'src/a.ts', body: 'x' })).status).toBe(200);
    expect((await post('/prs/app/2/threads', { commitOid: HEAD, path: 'src/a.ts', startLine: 1, body: 'x' })).error).toBe('startLine, endLine and snippet need a side');

    const { json } = makeApp();
    const t = (await json('POST', '/prs/app/2/threads', lineThread)).body;
    for (const [method, path, body] of [
      ['PATCH', `/threads/${t.id}`, { status: 'closed' }],
      ['POST', `/threads/${t.id}/comments`, { body: '' }],
      ['PATCH', `/comments/${t.comments[0]!.id}`, {}],
      ['GET', '/threads/x', undefined],
      ['GET', '/prs/app/2/threads?format=csv', undefined],
    ] as const) {
      expect((await send(method, path, body)).status, `${method} ${path}`).toBe(400);
    }
    for (const [method, path, body] of [
      ['GET', '/threads/999', undefined],
      ['PATCH', '/threads/999', { status: 'open' }],
      ['DELETE', '/threads/999', undefined],
      ['POST', '/threads/999/comments', { body: 'x' }],
      ['PATCH', '/comments/999', { body: 'x' }],
      ['DELETE', '/comments/999', undefined],
      ['GET', '/prs/nope/1/threads', undefined],
    ] as const) {
      expect((await send(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("serves no thread of a removed repo, by id or by target, until the repo is back", async () => {
    const { db, json, send } = makeApp();
    const t = (await json('POST', '/prs/app/2/threads', lineThread)).body;
    const reply = (await json('POST', `/threads/${t.id}/comments`, { body: 'Because.' })).body.comments[1]!;
    const commitThread = (await json('POST', `/commits/app/${COMMIT}/threads`, { body: 'x' })).body;
    const before = db.all('SELECT * FROM comments ORDER BY id');
    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE name = 'app'");
    const routes = [
      ['GET', `/threads/${t.id}`, undefined, 'Thread not found'],
      ['PATCH', `/threads/${t.id}`, { status: 'resolved' }, 'Thread not found'],
      ['DELETE', `/threads/${t.id}`, undefined, 'Thread not found'],
      ['DELETE', `/threads/${commitThread.id}`, undefined, 'Thread not found'],
      ['POST', `/threads/${t.id}/comments`, { body: 'More' }, 'Thread not found'],
      ['PATCH', `/comments/${reply.id}`, { body: 'Edited' }, 'Comment not found'],
      ['DELETE', `/comments/${reply.id}`, undefined, 'Comment not found'],
      ['DELETE', `/comments/${t.comments[0]!.id}`, undefined, 'Comment not found'],
      ['GET', '/prs/app/2/threads', undefined, 'Repository not found'],
      ['POST', '/prs/app/2/threads', lineThread, 'Repository not found'],
      ['GET', `/commits/app/${COMMIT}/threads`, undefined, 'Repository not found'],
      ['POST', `/commits/app/${COMMIT}/threads`, { body: 'x' }, 'Repository not found'],
    ] as const;
    for (const [method, path, body, error] of routes) {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json(), `${method} ${path}`).toEqual({ error });
    }
    // Nothing changed underneath, and it all comes back with the repo.
    expect(db.all('SELECT * FROM comments ORDER BY id')).toEqual(before);
    expect(db.get<{ status: string }>('SELECT status FROM comment_threads WHERE id = ?', [t.id])!.status).toBe('open');
    db.run("UPDATE repos SET removed_at = NULL WHERE name = 'app'");
    expect((await json('GET', `/threads/${t.id}`)).body.comments.map((c) => c.body)).toEqual(['Why?', 'Because.']);
    expect((await json('PATCH', `/comments/${reply.id}`, { body: 'Edited' })).status).toBe(200);
  });

  it('finds its target only once the body is in: a thread or repo that went meanwhile is a 404, and nothing is written', async () => {
    const { db, json, sendLate } = makeApp();
    const open = async () => (await json('POST', '/prs/app/2/threads', lineThread)).body;
    const removeApp = () => db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE name = 'app'");
    const restoreApp = () => db.run("UPDATE repos SET removed_at = NULL WHERE name = 'app'");
    const expect404 = async (res: Response, error: string) => {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error });
    };

    // Reply, while the thread is deleted.
    const a = await open();
    await expect404(await sendLate('POST', `/threads/${a.id}/comments`, { body: 'Late' }, () => db.run('DELETE FROM comment_threads WHERE id = ?', [a.id])), 'Thread not found');
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM comments WHERE thread_id = ?', [a.id])!.n).toBe(0);

    // Resolve, reply and edit, while the repo is removed.
    const b = await open();
    await expect404(await sendLate('PATCH', `/threads/${b.id}`, { status: 'resolved' }, removeApp), 'Thread not found');
    restoreApp();
    await expect404(await sendLate('POST', `/threads/${b.id}/comments`, { body: 'Late' }, removeApp), 'Thread not found');
    restoreApp();
    await expect404(await sendLate('PATCH', `/comments/${b.comments[0]!.id}`, { body: 'Late' }, removeApp), 'Comment not found');
    restoreApp();
    expect((await json('GET', `/threads/${b.id}`)).body).toMatchObject({ status: 'open', comments: [{ body: 'Why?', editedAt: null }] });

    // Edit, while the comment's thread is deleted.
    const c = await open();
    await expect404(await sendLate('PATCH', `/comments/${c.comments[0]!.id}`, { body: 'Late' }, () => db.run('DELETE FROM comment_threads WHERE id = ?', [c.id])), 'Comment not found');

    // New threads, while the repo is removed.
    const before = db.get<{ n: number }>('SELECT count(*) AS n FROM comment_threads')!.n;
    await expect404(await sendLate('POST', '/prs/app/2/threads', lineThread, removeApp), 'Repository not found');
    restoreApp();
    await expect404(await sendLate('POST', `/commits/app/${COMMIT}/threads`, { body: 'Late' }, removeApp), 'Repository not found');
    restoreApp();
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM comment_threads')!.n).toBe(before);

    // Undisturbed, a late body is fine.
    expect((await sendLate('POST', `/threads/${b.id}/comments`, { body: 'Late' }, () => {})).status).toBe(200);
  });

  it("lets the dashboard user delete an agent's comments but not edit them", async () => {
    const { db, json } = makeApp();
    const t = (await json('POST', '/prs/app/2/threads', lineThread)).body;
    const agent = db.run("INSERT INTO principals (kind, name, created_at) VALUES ('agent', 'Reviewer', '2026-09-29T00:00:00Z')").lastInsertRowid;
    const agentComment = db.run("INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, 'Nit', '2026-09-29T00:00:00Z')", [t.id, agent]).lastInsertRowid;
    const edit = await json<{ error: string }>('PATCH', `/comments/${agentComment}`, { body: 'Not a nit' });
    expect(edit).toEqual({ status: 403, body: { error: 'You can only edit your own comments' } });
    expect((await json('DELETE', `/comments/${agentComment}`)).status).toBe(200);
  });

  it('exports threads as Markdown', async () => {
    const { json, send } = makeApp();
    await json('POST', '/prs/app/2/threads', lineThread);
    const res = await send('GET', '/prs/app/2/threads?format=md');
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('# app#2\n\n### `src/a.ts` lines 3–4 (new)\n\n```ts\na\nb\n```\n\n- **You**: Why?\n');
    const commit = await send('GET', `/commits/app/${COMMIT}/threads?format=md`);
    expect(await commit.text()).toBe('# app@ccccccc\n');
    // The largest snippet the API takes, all backtick runs.
    const snippet = '`x'.repeat(128 * 1024);
    expect((await json('POST', '/prs/app/3/threads', { ...lineThread, startLine: 1, endLine: 1, snippet })).status).toBe(200);
    const big = await send('GET', '/prs/app/3/threads?format=md');
    expect(big.status).toBe(200);
    expect(await big.text()).toContain(`\`\`\`ts\n${snippet}\n\`\`\`\n`);
  });

  it('counts threads on PRs and filters the PR list by them', async () => {
    const { json, send } = makeApp();
    const t = (await json('POST', '/prs/app/2/threads', lineThread)).body;
    await json('POST', '/prs/app/3/threads', lineThread);
    await json('PATCH', `/threads/${t.id}`, { status: 'resolved' });
    const range = 'from=2026-09-01&to=2026-09-27&tz=UTC&repos=app';
    const ids = async (query: string) => ((await json<{ items: { id: string }[] }>('GET', `/prs?${range}&${query}`)).body.items.map((p) => p.id));
    expect(await ids('comments=any')).toEqual(['alice/app#3', 'alice/app#2']);
    expect(await ids('comments=unresolved')).toEqual(['alice/app#3']);
    expect((await send('GET', `/prs?${range}&comments=all`)).status).toBe(400);
    expect((await json('GET', '/prs/app/2')).body).toMatchObject({ comments: { threads: 1, unresolved: 0 } });
    const csv = await (await send('GET', `/prs?${range}&comments=unresolved&format=csv`)).text();
    expect(csv.trim().split('\n').slice(1).map((row) => row.split(',').slice(0, 2).join('#'))).toEqual(['alice/app#3']);
  });

  it('rejects cross-origin writes', async () => {
    const { send } = makeApp();
    const res = await send('POST', '/prs/app/2/threads', lineThread, { origin: 'https://evil.example', host: 'localhost' });
    expect(res.status).toBe(403);
    expect((await send('POST', '/prs/app/2/threads', lineThread, { origin: 'http://localhost', host: 'localhost' })).status).toBe(200);
  });

  it('is in the OpenAPI document', async () => {
    const { app } = makeApp();
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
    expect(Object.keys(doc.paths['/api/v1/prs/{repo}/{number}/threads']!)).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/api/v1/commits/{repo}/{oid}/threads']!)).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/api/v1/threads']!)).toEqual(['get']);
    expect(Object.keys(doc.paths['/api/v1/threads/{id}']!)).toEqual(['get', 'patch', 'delete']);
    expect(Object.keys(doc.paths['/api/v1/threads/{id}/comments']!)).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/comments/{id}']!)).toEqual(['patch', 'delete']);
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['CommentThread', 'ThreadComment', 'Principal', 'NewThread', 'CommentCounts', 'ThreadListItem']));
  });

  type Op = { requestBody?: { content: Record<string, { schema: unknown }> }; responses: Record<string, { content?: Record<string, unknown> }> };
  const openApi = async () =>
    (await (await makeApp().app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, Op>>;
      components: { schemas: Record<string, { required: string[] }> };
    };

  it('documents that a PR thread must name its head and a commit thread needn\'t', async () => {
    const doc = await openApi();
    const bodyRef = (path: string) => doc.paths[path]!.post!.requestBody!.content['application/json']!.schema;
    expect(bodyRef('/api/v1/prs/{repo}/{number}/threads')).toEqual({ $ref: '#/components/schemas/NewPrThread' });
    expect(bodyRef('/api/v1/commits/{repo}/{oid}/threads')).toEqual({ $ref: '#/components/schemas/NewThread' });
    expect(doc.components.schemas.NewPrThread!.required).toEqual(['commitOid', 'body']);
    expect(doc.components.schemas.NewThread!.required).toEqual(['body']);
  });

  it('documents GET /threads: its parameters, the item with its extras, and the counts', async () => {
    const doc = await openApi();
    type Documented = Op & { parameters: { name: string; in: string; schema: { enum?: string[]; default?: unknown } }[]; description: string };
    const op = doc.paths['/api/v1/threads']!.get! as Documented;
    expect(op.parameters.map((param) => param.name)).toEqual(['status', 'kind', 'sort', 'repos', 'source', 'visibility', 'ownership', 'q', 'limit', 'cursor', 'format']);
    expect(op.parameters.every((param) => param.in === 'query')).toBe(true);
    const param = (name: string) => op.parameters.find((x) => x.name === name)!.schema;
    expect(param('status')).toMatchObject({ enum: ['open', 'resolved', 'all'], default: 'open' });
    expect(param('kind')).toMatchObject({ enum: ['pr', 'commit', 'all'], default: 'all' });
    expect(param('sort')).toMatchObject({ enum: ['recent', 'oldest'], default: 'recent' });
    expect(param('format').enum).toEqual(['json', 'md']);
    // who, from, to, range and tz are accepted, not documented as parameters.
    expect(op.description).toContain('`who`, `from`, `to`, `range` and `tz` are accepted and ignored');
    const body = (op.responses['200']!.content!['application/json'] as { schema: { properties: Record<string, { items?: unknown; properties?: Record<string, unknown> }>; required: string[] } }).schema;
    expect(body.required).toEqual(['items', 'nextCursor', 'total', 'counts']);
    expect(body.properties.items!.items).toEqual({ $ref: '#/components/schemas/ThreadListItem' });
    expect(Object.keys(body.properties.counts!.properties!)).toEqual(['open', 'resolved']);
    const item = doc.components.schemas.ThreadListItem as unknown as { allOf: [{ $ref: string }, { properties: Record<string, unknown>; required: string[] }] };
    expect(item.allOf[0]).toEqual({ $ref: '#/components/schemas/CommentThread' });
    expect(Object.keys(item.allOf[1].properties)).toEqual(['targetTitle', 'prState', 'targetUrl', 'earlierPush']);
    expect(item.allOf[1].required).toEqual(['targetTitle', 'prState', 'targetUrl', 'earlierPush']);
    expect(await (await makeApp().app.request('/api/docs')).text()).toContain('/api/v1/threads');
  });

  it('documents Markdown besides JSON for the thread lists, and no CSV', async () => {
    const doc = await openApi();
    const types = (path: string) => Object.keys(doc.paths[path]!.get!.responses['200']!.content!);
    expect(types('/api/v1/prs/{repo}/{number}/threads')).toEqual(['application/json', 'text/markdown']);
    expect(types('/api/v1/commits/{repo}/{oid}/threads')).toEqual(['application/json', 'text/markdown']);
    expect(types('/api/v1/threads')).toEqual(['application/json', 'text/markdown']);
    expect(types('/api/v1/prs')).toEqual(['application/json', 'text/markdown', 'text/csv']);
    const docs = await (await makeApp().app.request('/api/docs')).text();
    expect(docs).toContain('Response: 200 · JSON, or <code>format=md</code></p>');
    expect(docs).toContain('Response: 200 · JSON, or <code>format=md</code> / <code>format=csv</code></p>');
  });
});

describe('GET /threads', () => {
  const at = (minute: number) => `2026-09-29T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const C1 = 'c1'.padEnd(40, '0'); // the seed's synced commit "Merge pull request #1"
  const UNSYNCED = 'd'.repeat(40);
  const APP_HEAD = '2'.repeat(40); // the seed's head of alice/app#2

  /** Threads made straight in the database, at the given minute, so activity times are known. */
  function seedThreads(db: Db) {
    const me = getPrincipal(db, SELF_PRINCIPAL_ID)!;
    const id = (key: string) => db.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', [key])!.id;
    const make = (target: ThreadTarget, body: string, minute: number, path: string | null = null, lines = false) =>
      createThread(db, target, {
        commitOid: target.kind === 'commit' ? target.oid : HEAD,
        baseOid: BASE,
        anchor: lines
          ? { path, side: 'new', startLine: 3, endLine: 4, snippet: 'a\nb' }
          : { path, side: null, startLine: null, endLine: null, snippet: null },
        body,
      }, me, at(minute)).id;
    return { id, make, me };
  }

  /** One thread per kind of target, at minutes 1 to 5, newest last created. */
  function targetsDb() {
    const db = seedDb();
    seedGitLab(db);
    const { id, make } = seedThreads(db);
    const line = make({ repoId: id('alice/app'), kind: 'pr', number: 2 }, 'Why two?', 1, 'src/a.ts', true);
    const mr = make({ repoId: id(`${GITLAB_HOST}/platform/app`), kind: 'pr', number: 2 }, 'Overall fine.', 2);
    const commit = make({ repoId: id('alice/app'), kind: 'commit', oid: C1 }, 'Nit', 3, 'README.md');
    const general = make({ repoId: id('alice/app'), kind: 'pr', number: 2 }, 'Second thought', 4);
    const orphan = make({ repoId: id('alice/app'), kind: 'pr', number: 99 }, 'Unsynced', 5);
    return { db, id, make, ids: { line, mr, commit, general, orphan } };
  }

  const get = async (app: ReturnType<typeof makeApp>, query = '') => {
    const res = await app.send('GET', `/threads${query}`);
    return { status: res.status, body: (await res.json()) as ThreadListResponse & { error?: string; details?: unknown } };
  };
  const idsOf = (res: { body: ThreadListResponse }) => res.body.items.map((t) => t.id);

  it('lists the open threads of every target, newest activity first, with total and counts', async () => {
    const { db, ids } = targetsDb();
    const app = makeApp(db);
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([ids.orphan, ids.general, ids.commit, ids.mr, ids.line]);
    expect(res.body).toMatchObject({ nextCursor: null, total: 5, counts: { open: 5, resolved: 0 } });
    expect(res.body.items.map((t) => [t.kind, t.repo, t.number, t.targetTitle, t.prState])).toEqual([
      ['pr', 'alice/app', 99, null, null],
      ['pr', 'alice/app', 2, 'Add parser', 'open'],
      ['commit', 'alice/app', null, 'Merge pull request #1', null],
      ['pr', `${GITLAB_HOST}/platform/app`, 2, 'Rework config', 'open'],
      ['pr', 'alice/app', 2, 'Add parser', 'open'],
    ]);
    // The item is the per-target thread, plus what it is on.
    const perTarget = (await app.json<{ items: CommentThread[] }>('GET', '/prs/app/2/threads')).body.items;
    const { targetTitle, prState, targetUrl, earlierPush, ...thread } = res.body.items.find((t) => t.id === ids.line)!;
    expect(thread).toEqual(perTarget.find((t) => t.id === ids.line));
    expect({ targetTitle, prState, targetUrl, earlierPush }).toEqual({ targetTitle: 'Add parser', prState: 'open', targetUrl: 'https://github.com/alice/x/pull/2', earlierPush: true });
  });

  it('follows the per-thread routes: resolving, replying and deleting', async () => {
    const { db, ids } = targetsDb();
    const app = makeApp(db);
    expect((await app.json('PATCH', `/threads/${ids.commit}`, { status: 'resolved' })).status).toBe(200);
    expect(idsOf(await get(app))).toEqual([ids.orphan, ids.general, ids.mr, ids.line]);
    expect((await get(app, '?status=resolved')).body).toMatchObject({ total: 1, counts: { open: 4, resolved: 1 } });
    // The reply moves the (resolved) thread's activity to now, past the seeded ones.
    await app.json('POST', `/threads/${ids.commit}/comments`, { body: 'Reopening soon' });
    expect(idsOf(await get(app, '?status=all'))[0]).toBe(ids.commit);
    expect((await app.send('DELETE', `/threads/${ids.commit}`)).status).toBe(204);
    expect((await get(app, '?status=all')).body).toMatchObject({ total: 4, counts: { open: 4, resolved: 0 } });
    // /threads/:id is still its own route.
    expect((await app.json('GET', `/threads/${ids.line}`)).body).toMatchObject({ id: ids.line, comments: [{ body: 'Why two?' }] });
  });

  it('is empty without threads', async () => {
    expect(await get(makeApp())).toEqual({ status: 200, body: { items: [], nextCursor: null, total: 0, counts: { open: 0, resolved: 0 } } });
  });

  it('accepts who, from, to, range and tz and ignores them, even when they would be errors elsewhere', async () => {
    const { db, ids } = targetsDb();
    const app = makeApp(db);
    const plain = idsOf(await get(app));
    expect(plain).toHaveLength(5);
    for (const query of ['who=me', 'from=2020-01-01&to=2020-01-02', 'range=7d&tz=Europe/Berlin', 'who=bogus&from=garbage&to=nonsense&range=&tz=Not/AZone', 'unknown=1']) {
      const res = await get(app, `?${query}`);
      expect([query, res.status, idsOf(res)]).toEqual([query, 200, plain]);
    }
    expect(plain[0]).toBe(ids.orphan);
  });

  it('rejects bad values of its own parameters with 400', async () => {
    const app = makeApp(targetsDb().db);
    const other = encodeURIComponent(btoa(JSON.stringify(['oldest', at(3), 1])));
    for (const query of [
      'status=closed', 'status=', 'kind=issue', 'sort=newest', 'sort=file', 'limit=0', 'limit=1001', 'limit=x', 'format=csv', 'format=xml',
      'cursor=garbage', 'cursor=W10', `cursor=${other}`, 'visibility=secret', 'ownership=yours',
    ]) {
      const res = await get(app, `?${query}`);
      expect([query, res.status, typeof res.body.error]).toEqual([query, 400, 'string']);
    }
    // Under md the limit and cursor are ignored, but a bad limit is still not a valid request.
    expect((await app.send('GET', '/threads?format=md&limit=0')).status).toBe(400);
  });

  it('filters by status, kind and text', async () => {
    const { db, ids } = targetsDb();
    const app = makeApp(db);
    await app.json('PATCH', `/threads/${ids.general}`, { status: 'resolved' });
    expect(idsOf(await get(app, '?status=resolved'))).toEqual([ids.general]);
    expect(idsOf(await get(app, '?status=all'))).toEqual([ids.general, ids.orphan, ids.commit, ids.mr, ids.line]);
    expect(idsOf(await get(app, '?kind=commit'))).toEqual([ids.commit]);
    expect(idsOf(await get(app, '?kind=pr&status=all'))).toEqual([ids.general, ids.orphan, ids.mr, ids.line]);
    expect((await get(app, '?kind=commit&status=resolved')).body).toMatchObject({ total: 0, counts: { open: 1, resolved: 0 } });
    expect(idsOf(await get(app, '?q=readme'))).toEqual([ids.commit]);
    expect(idsOf(await get(app, '?q=+why+'))).toEqual([ids.line]);
    expect(idsOf(await get(app, `?q=${encodeURIComponent('%')}`))).toEqual([]);
    expect((await get(app, '?q=nothing')).body).toMatchObject({ items: [], total: 0, counts: { open: 0, resolved: 0 } });
  });

  it('pages with an opaque cursor in both sorts, and refuses a cursor made under the other sort', async () => {
    const { db, ids } = targetsDb();
    const app = makeApp(db);
    // Two more at minute 3, tied with the commit thread.
    const { make, id } = seedThreads(db);
    const tied = [1, 2].map((n) => make({ repoId: id('alice/app'), kind: 'pr', number: 2 }, `tied ${n}`, 3));
    const walk = async (sort: string, limit: number) => {
      const seen: number[][] = [];
      let cursor: string | null = null;
      do {
        const res = await get(app, `?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res).toMatchObject({ status: 200, body: { total: 7, counts: { open: 7, resolved: 0 } } });
        seen.push(idsOf(res));
        cursor = res.body.nextCursor;
      } while (cursor);
      return seen;
    };
    const recent = [ids.orphan, ids.general, tied[1]!, tied[0]!, ids.commit, ids.mr, ids.line];
    expect(idsOf(await get(app))).toEqual(recent);
    expect(idsOf(await get(app, '?sort=recent'))).toEqual(recent);
    expect(idsOf(await get(app, '?sort=oldest'))).toEqual([...recent].reverse());
    expect(await walk('recent', 3)).toEqual([recent.slice(0, 3), recent.slice(3, 6), recent.slice(6)]);
    expect(await walk('oldest', 2)).toEqual([[...recent].reverse().slice(0, 2), [...recent].reverse().slice(2, 4), [...recent].reverse().slice(4, 6), [recent[0]!]]);
    // The cursor is base64url JSON [sort, updatedAt, id], and belongs to its sort.
    const page = await get(app, '?limit=1');
    expect(JSON.parse(Buffer.from(page.body.nextCursor!, 'base64url').toString())).toEqual(['recent', at(5), ids.orphan]);
    expect((await get(app, `?limit=1&cursor=${page.body.nextCursor}`)).status).toBe(200);
    const wrong = await get(app, `?sort=oldest&limit=1&cursor=${page.body.nextCursor}`);
    expect(wrong).toMatchObject({ status: 400, body: { error: expect.stringContaining('sort') } });
    // An update in between doesn't lose a thread the cursor has passed: it just moves.
    const first = await get(app, '?limit=2');
    await app.json('POST', `/threads/${ids.line}/comments`, { body: 'bump' });
    const rest = await get(app, `?limit=10&cursor=${first.body.nextCursor}`);
    expect(idsOf(rest)).toEqual(recent.slice(2, 6));
  });

  it('applies the scope as /prs does: default selection, explicit repos, source, visibility, ownership, removed repos', async () => {
    const { db, id, make } = targetsDb();
    const app = makeApp(db);
    const archived = make({ repoId: id('alice/old'), kind: 'pr', number: 1 }, 'in an archived repo', 6);
    const secret = make({ repoId: id('alice/secret'), kind: 'pr', number: 1 }, 'in a private repo', 7);
    expect(await get(app, '')).toMatchObject({ body: { total: 6 } });
    expect(idsOf(await get(app))).not.toContain(archived);
    expect(idsOf(await get(app, '?repos=alice/old'))).toEqual([archived]);
    expect(idsOf(await get(app, '?repos=old,secret'))).toEqual([secret, archived]);
    expect((await get(app, '?repos=')).body).toMatchObject({ items: [], total: 0 });
    expect(idsOf(await get(app, '?visibility=private'))).toEqual([secret]);
    expect(idsOf(await get(app, '?ownership=others'))).toEqual([]);
    expect((await get(app, `?source=${GITLAB_HOST}`)).body.items.map((t) => t.repo)).toEqual([`${GITLAB_HOST}/platform/app`]);
    expect((await get(app, '?source=GITHUB.COM')).body.total).toBe(5);
    // The counts carry the same scope.
    expect((await get(app, '?repos=alice/old')).body.counts).toEqual({ open: 1, resolved: 0 });

    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE key = 'alice/app'");
    expect(idsOf(await get(app, '?status=all'))).toEqual([secret, (await get(app, '?source=' + GITLAB_HOST)).body.items[0]!.id]);
    expect((await get(app, '?repos=alice/app&status=all')).body).toMatchObject({ items: [], total: 0, counts: { open: 0, resolved: 0 } });
    db.run('UPDATE repos SET removed_at = NULL WHERE key = ?', ['alice/app']);
    expect((await get(app)).body.total).toBe(6);
  });

  it('rejects a source that is not one of this database\'s, and says which are', async () => {
    const app = makeApp(targetsDb().db);
    const res = await get(app, '?source=nowhere.example');
    expect(res).toMatchObject({ status: 400, body: { error: expect.stringContaining('nowhere.example'), details: { sources: ['github.com', GITLAB_HOST] } } });
    expect((await get(app, `?source=github.com,nowhere.example`)).status).toBe(400);
    expect((await app.send('GET', '/threads?format=md&source=nowhere.example')).status).toBe(400);
  });

  it('knows what a thread is on only when it is synced: PR and commit rows, and the head', async () => {
    const { db, id, make } = targetsDb();
    const app = makeApp(db);
    const onHead = createThread(db, { repoId: id('alice/app'), kind: 'pr', number: 2 }, { commitOid: APP_HEAD, baseOid: BASE, anchor: { path: null, side: null, startLine: null, endLine: null, snippet: null }, body: 'on the head' }, getPrincipal(db, 1)!, at(9)).id;
    const noHead = make({ repoId: id('alice/app'), kind: 'pr', number: 3 }, 'no head known', 10);
    db.run('UPDATE pull_requests SET head_oid = NULL WHERE repo_id = ? AND number = 3', [id('alice/app')]);
    const unsyncedCommit = make({ repoId: id('alice/app'), kind: 'commit', oid: UNSYNCED }, 'unsynced commit', 11);
    const byId = new Map((await get(app)).body.items.map((t) => [t.id, t]));
    expect(byId.get(onHead)).toMatchObject({ earlierPush: false, prState: 'open', targetTitle: 'Add parser' });
    expect(byId.get(noHead)).toMatchObject({ earlierPush: false, prState: 'closed', targetTitle: 'PR 3', targetUrl: 'https://github.com/alice/x/pull/3' });
    expect(byId.get(unsyncedCommit)).toMatchObject({ kind: 'commit', targetTitle: null, prState: null, targetUrl: null, earlierPush: false });
    const synced = [...byId.values()].find((t) => t.kind === 'commit' && t.targetTitle)!;
    expect(synced).toMatchObject({ targetTitle: 'Merge pull request #1', targetUrl: 'https://github.com/c/c1', earlierPush: false });
    const orphan = [...byId.values()].find((t) => t.number === 99)!;
    expect(orphan).toMatchObject({ targetTitle: null, prState: null, targetUrl: null, earlierPush: false });
  });

  describe('as Markdown', () => {
    it('groups the threads per PR or commit in order of first appearance, with the host\'s words and refs', async () => {
      const { db } = targetsDb();
      const app = makeApp(db);
      const res = await app.send('GET', '/threads?format=md');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(await res.text()).toBe(
        [
          '# Comments · unresolved',
          '## alice/app#99',
          '### Pull request\n\n- **You**: Unsynced',
          '## alice/app#2 · Add parser',
          '### Pull request\n\n- **You**: Second thought',
          '### `src/a.ts` lines 3–4 (new)\n\n```ts\na\nb\n```\n\n- **You**: Why two?',
          `## alice/app@${C1.slice(0, 7)} · Merge pull request #1`,
          '### `README.md`\n\n- **You**: Nit',
          `## ${GITLAB_HOST}/platform/app!2 · Rework config`,
          '### Merge request\n\n- **You**: Overall fine.',
        ].join('\n\n') + '\n',
      );
    });

    it('follows the sort, the filters and the status heading; and ignores limit and cursor', async () => {
      const { db, ids } = targetsDb();
      const app = makeApp(db);
      const md = async (query: string) => (await (await app.send('GET', `/threads?format=md${query}`)).text());
      const headings = (text: string) => text.split('\n').filter((l) => /^#{1,2} /.test(l));
      expect(headings(await md('&sort=oldest'))).toEqual([
        '# Comments · unresolved', '## alice/app#2 · Add parser', `## ${GITLAB_HOST}/platform/app!2 · Rework config`,
        `## alice/app@${C1.slice(0, 7)} · Merge pull request #1`, '## alice/app#99',
      ]);
      expect(headings(await md('&limit=1&cursor=garbage'))).toHaveLength(5);
      expect(headings(await md('&kind=commit'))).toEqual(['# Comments · unresolved', `## alice/app@${C1.slice(0, 7)} · Merge pull request #1`]);
      await app.json('PATCH', `/threads/${ids.commit}`, { status: 'resolved' });
      const resolved = await md('&status=resolved');
      expect(resolved).toBe(`# Comments · resolved\n\n## alice/app@${C1.slice(0, 7)} · Merge pull request #1\n\n### \`README.md\` · resolved\n\n- **You**: Nit\n`);
      expect(headings(await md('&status=all'))[0]).toBe('# Comments · all');
      expect(await md('&q=nothing-like-this')).toBe('# Comments · unresolved\n\n_No unresolved comments._\n');
      expect(await md('&status=resolved&kind=pr')).toBe('# Comments · resolved\n\n_No resolved comments._\n');
      expect(await md('&status=all&repos=')).toBe('# Comments · all\n\n_No comments._\n');
    });

    it('escapes a title\'s markup and puts an unsynced target\'s ref alone', async () => {
      const { db } = targetsDb();
      db.run("UPDATE pull_requests SET title = 'Fix *all* [the] things' WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE key = 'alice/app')");
      const text = await (await makeApp(db).send('GET', '/threads?format=md&kind=pr&source=github.com')).text();
      expect(text).toContain('## alice/app#2 · Fix \\*all\\* \\[the\\] things\n');
      expect(text).toContain('\n## alice/app#99\n');
    });
  });
});
