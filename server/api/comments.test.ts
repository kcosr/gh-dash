import { describe, expect, it } from 'vitest';
import type { CommentThread } from '../../shared/api';
import { loadConfig } from '../config';
import type { Db } from '../db/db';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { seedDb } from '../test/seed';
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
      kind: 'pr', repo: 'app', number: 2, commitOid: HEAD, baseOid: BASE, path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4,
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
    expect(await post('/commits/app/abc1234/threads', { body: 'x' })).toEqual({ status: 400, error: 'Invalid oid: expected a full 40-character commit SHA' });

    const bad: [Record<string, unknown>, string][] = [
      [{ commitOid: undefined }, 'commitOid'],
      [{ commitOid: 'abc1234' }, 'commitOid: expected a full 40-character commit SHA'],
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
    expect(await ids('comments=any')).toEqual(['app#3', 'app#2']);
    expect(await ids('comments=unresolved')).toEqual(['app#3']);
    expect((await send('GET', `/prs?${range}&comments=all`)).status).toBe(400);
    expect((await json('GET', '/prs/app/2')).body).toMatchObject({ comments: { threads: 1, unresolved: 0 } });
    const csv = await (await send('GET', `/prs?${range}&comments=unresolved&format=csv`)).text();
    expect(csv.trim().split('\n').slice(1).map((row) => row.split(',').slice(0, 2).join('#'))).toEqual(['app#3']);
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
    expect(Object.keys(doc.paths['/api/v1/threads/{id}']!)).toEqual(['get', 'patch', 'delete']);
    expect(Object.keys(doc.paths['/api/v1/threads/{id}/comments']!)).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/comments/{id}']!)).toEqual(['patch', 'delete']);
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['CommentThread', 'ThreadComment', 'Principal', 'NewThread', 'CommentCounts']));
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

  it('documents Markdown besides JSON for the thread lists, and no CSV', async () => {
    const doc = await openApi();
    const types = (path: string) => Object.keys(doc.paths[path]!.get!.responses['200']!.content!);
    expect(types('/api/v1/prs/{repo}/{number}/threads')).toEqual(['application/json', 'text/markdown']);
    expect(types('/api/v1/commits/{repo}/{oid}/threads')).toEqual(['application/json', 'text/markdown']);
    expect(types('/api/v1/prs')).toEqual(['application/json', 'text/markdown', 'text/csv']);
    const docs = await (await makeApp().app.request('/api/docs')).text();
    expect(docs).toContain('Response: 200 · JSON, or <code>format=md</code></p>');
    expect(docs).toContain('Response: 200 · JSON, or <code>format=md</code> / <code>format=csv</code></p>');
  });
});
