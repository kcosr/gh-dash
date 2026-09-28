/** Hand-written OpenAPI 3.1 document for /api/v1, mirroring shared/api.ts. Also drives the /api/docs page. */

type Schema = Record<string, unknown>;

const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: 'integer', ...(description ? { description } : {}) });
const num: Schema = { type: 'number' };
const bool: Schema = { type: 'boolean' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: Schema): Schema => ({ type: 'array', items });
function nullable(s: Schema): Schema {
  if ('$ref' in s) return { anyOf: [s, { type: 'null' }] };
  return { ...s, type: [s.type, 'null'], ...(Array.isArray(s.enum) ? { enum: [...s.enum, null] } : {}) };
}
const enumOf = (...values: string[]): Schema => ({ type: 'string', enum: values });
const obj = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
});

const schemas: Record<string, Schema> = {
  Error: obj({ error: str(), details: {} }, ['details']),
  Actor: obj({ login: nullable(str()), name: nullable(str()), avatarUrl: nullable(str()), isMe: bool }),
  Label: obj({ name: str(), color: str('Hex without #') }),
  RepoStats: obj({
    openPrs: int(), openIssues: int(), mergedPrs30d: int(), commits30d: int(), newStars30d: int(),
    weeklyCommits: { ...arr(int()), description: '12 Mon-start weeks (server tz), oldest first' },
  }),
  Repo: obj({
    name: str(), nameWithOwner: str(), owner: str(), description: nullable(str()), url: str(),
    visibility: enumOf('public', 'private'), isArchived: bool, isFork: bool,
    language: nullable(obj({ name: str(), color: nullable(str()) })), topics: arr(str()), defaultBranch: nullable(str()),
    stars: int(), forks: int(), createdAt: dateTime, pushedAt: nullable(dateTime), lastActivityAt: nullable(dateTime),
    pinned: bool, hidden: bool, setIds: arr(int()), stats: ref('RepoStats'), syncedAt: nullable(dateTime),
  }),
  PullRequest: obj({
    id: str('<repo>#<number>'), repo: str(), number: int(), title: str(), body: str('Markdown'),
    state: enumOf('open', 'merged', 'closed'), isDraft: bool, author: ref('Actor'), mergedBy: nullable(str()),
    createdAt: dateTime, updatedAt: dateTime, mergedAt: nullable(dateTime), closedAt: nullable(dateTime),
    activityAt: { ...dateTime, description: 'mergedAt if merged, closedAt if closed, else createdAt' },
    additions: int(), deletions: int(), changedFiles: int(), commitCount: int(), headRef: str(), baseRef: str(),
    labels: arr(ref('Label')), url: str(),
  }),
  PullRequestDetail: {
    allOf: [
      ref('PullRequest'),
      obj({
        commits: arr(obj({ oid: str(), headline: str(), committedAt: dateTime, url: str(), author: ref('Actor') })),
        closingIssues: arr(obj({ number: int(), title: str(), state: enumOf('open', 'closed'), url: str() })),
      }),
    ],
  },
  Commit: obj({
    oid: str(), shortOid: str(), repo: str(), headline: str(), body: str(), author: ref('Actor'), committedAt: dateTime,
    url: str(), additions: int(), deletions: int(), prNumber: nullable(int('Set when the commit landed via a PR')),
  }),
  Issue: obj({
    id: str('<repo>#<number>'), repo: str(), number: int(), title: str(), body: str(), state: enumOf('open', 'closed'),
    author: ref('Actor'), closedBy: nullable(ref('Actor')), createdAt: dateTime, updatedAt: dateTime,
    closedAt: nullable(dateTime), labels: arr(ref('Label')), url: str(),
  }),
  Release: obj({
    id: str('<repo>@<tag>'), repo: str(), tag: str(), name: nullable(str()), body: str(), author: nullable(ref('Actor')),
    publishedAt: dateTime, isPrerelease: bool, url: str(),
  }),
  Star: obj({ repo: str(), user: ref('Actor'), starredAt: dateTime }),
  ActivityEvent: {
    description: 'Commit events only include commits not associated with a PR.',
    oneOf: [
      obj({ type: enumOf('commit'), at: dateTime, repo: str(), actor: ref('Actor'), commit: ref('Commit') }),
      obj({ type: enumOf('pr'), kind: enumOf('opened', 'merged', 'closed'), at: dateTime, repo: str(), actor: ref('Actor'), pr: ref('PullRequest') }),
      obj({ type: enumOf('issue'), kind: enumOf('opened', 'closed'), at: dateTime, repo: str(), actor: ref('Actor'), issue: ref('Issue') }),
      obj({ type: enumOf('release'), at: dateTime, repo: str(), actor: nullable(ref('Actor')), release: ref('Release') }),
      obj({ type: enumOf('star'), at: dateTime, repo: str(), actor: ref('Actor') }),
    ],
  },
  Facets: obj(
    {
      byRepo: { type: 'object', additionalProperties: int(), description: 'Counts per repo, ignoring the repos filter' },
      byType: { type: 'object', additionalProperties: int(), description: 'Activity only; counts per type, ignoring the types filter' },
      byDay: {
        type: 'object',
        additionalProperties: int(),
        description: "Activity only; counts per local day ('YYYY-MM-DD' in tz) with every filter applied, including types. Days without events are omitted.",
      },
    },
    ['byType', 'byDay'],
  ),
  RepoSet: obj({ id: int(), name: str(), repos: arr(str()) }),
  SavedView: obj({ id: int(), name: str(), path: str('App route, e.g. /prs'), query: str('Query string without ?') }),
  Settings: obj({
    syncIntervalMinutes: { ...int(), minimum: 5, maximum: 1440 },
    backfillDays: { ...int(), minimum: 1, maximum: 3650 },
    myEmails: arr(str()),
    myEmailsFromEnv: { ...arr(str()), readOnly: true, description: 'Emails from GH_DASH_MY_EMAILS; always count as "me". Ignored in PATCH.' },
    includeForks: bool,
  }, ['myEmailsFromEnv']),
  Me: obj({ login: str(), name: nullable(str()), avatarUrl: nullable(str()), tokenSource: enumOf('env', 'gh-cli', 'none') }),
  SyncStatus: obj({
    running: bool,
    trigger: nullable(enumOf('manual', 'scheduled', 'startup')),
    progress: nullable(obj({ done: int(), total: int(), current: nullable(str()) })),
    lastSyncAt: nullable(dateTime),
    lastSyncDurationMs: nullable(int()),
    lastResult: nullable(obj({ newItems: int(), errors: arr(str()) })),
    nextSyncAt: nullable(dateTime),
    rateLimit: nullable(obj({ limit: int(), remaining: int(), resetAt: dateTime })),
    tokenSource: enumOf('env', 'gh-cli', 'none'),
    viewer: nullable(str()),
  }),
  Tile: obj({ value: nullable(num), previous: nullable(num), spark: { ...arr(num), description: '12 equal slices of the range' } }),
  StatsBucket: obj({
    start: str('YYYY-MM-DD in the requested tz'), commits: int(), commitsMine: int(), prsOpened: int(), prsMerged: int(),
    prsMergedMine: int(), issuesOpened: int(), issuesClosed: int(), releases: int(), stars: int(),
    medianHoursToMerge: nullable(num),
  }),
  StatsResponse: obj({
    range: obj({
      from: dateTime, to: { ...dateTime, description: 'Exclusive end' }, prevFrom: dateTime, prevTo: dateTime,
      bucket: enumOf('day', 'week', 'month'), tz: str(),
    }),
    tiles: obj(Object.fromEntries(['prsMerged', 'commits', 'newStars', 'medianHoursToMerge', 'issuesClosed', 'activeRepos'].map((k) => [k, ref('Tile')]))),
    series: arr(ref('StatsBucket')),
    stars: arr(obj({ date: str(), total: int(), added: int() })),
    commitCalendar: arr(obj({ date: str(), count: int() })),
    byRepo: arr(obj({ repo: str(), commits: int(), prsMerged: int(), issues: int(), releases: int(), stars: int(), total: int() })),
    contributors: arr(obj({ actor: ref('Actor'), commits: int(), prsMerged: int(), total: int() })),
  }),
};

const list = (item: Schema, withFacets = false): Schema =>
  obj({ items: arr(item), nextCursor: nullable(str()), total: int(), ...(withFacets ? { facets: ref('Facets') } : {}) });

export interface ParamDoc {
  name: string;
  in: 'query' | 'path';
  description: string;
  schema: Schema;
  required?: boolean;
  example?: string;
}

const q = (name: string, description: string, schema: Schema = str(), example?: string): ParamDoc => ({
  name, in: 'query', description, schema, ...(example ? { example } : {}),
});
const p = (name: string, description: string, schema: Schema = str()): ParamDoc => ({ name, in: 'path', description, schema, required: true });

const SCOPE: ParamDoc[] = [
  q('repos', 'Comma-separated repo names. Omitted: default scope (non-archived, non-hidden, non-fork unless includeForks). Empty (`repos=`): no repos.', str(), 'app,tools'),
  q('visibility', 'Repo visibility filter.', { ...enumOf('all', 'public', 'private'), default: 'all' }),
  q('who', "'me' = the authenticated user (login, settings.myEmails or GH_DASH_MY_EMAILS); stars are always by others.", { ...enumOf('me', 'others', 'everyone'), default: 'everyone' }, 'me'),
  q('from', 'Start: YYYY-MM-DD (in tz), ISO datetime, or relative offset like -7d / -12w / -3m. Default: 29 days before today.', str(), '-30d'),
  q('to', 'End, inclusive: YYYY-MM-DD covers that whole day. Same formats as from. Default: end of today. Bounds must lie in 1970–2999 and span at most 7320 days (~20 years).', str()),
  q('tz', 'IANA timezone for date-only bounds and bucketing. Default: server timezone.', str(), 'Europe/Berlin'),
  q('q', 'Full-text search (FTS5) over titles, bodies, commit messages and release notes; last word prefix-matches.', str()),
];
const PAGE: ParamDoc[] = [
  q('limit', 'Page size (max 1000).', { ...int(), default: 200, minimum: 1, maximum: 1000 }),
  q('cursor', 'Opaque cursor from a previous nextCursor.', str()),
  q('format', "'md' (text/markdown) or 'csv' (text/csv) return every matching item, ignoring limit/cursor.", { ...enumOf('json', 'md', 'csv'), default: 'json' }),
];

export interface EndpointDoc {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  description?: string;
  params?: ParamDoc[];
  body?: { schema: Schema; example: unknown; optional?: boolean };
  response: { status: number; schema?: Schema; description?: string };
  textFormats?: boolean;
  example?: string;
}

export const ENDPOINTS: EndpointDoc[] = [
  { method: 'get', path: '/api/health', tag: 'System', summary: 'Liveness check (never requires auth)', response: { status: 200, schema: obj({ ok: bool, version: str() }) } },
  { method: 'get', path: '/api/v1/me', tag: 'System', summary: 'Authenticated GitHub user and token source', response: { status: 200, schema: ref('Me') } },
  {
    method: 'get', path: '/api/v1/prs', tag: 'Lists', summary: 'Pull requests',
    description: 'Filtered and sorted on activityAt desc (tie-break repo, number). facets.byRepo ignores the repos filter.',
    params: [
      ...SCOPE,
      q('state', 'PR state.', { ...enumOf('open', 'merged', 'closed', 'all'), default: 'all' }, 'merged'),
      q('labels', 'Comma-separated; PR must have at least one (case-insensitive).'),
      q('group', 'Headings for format=md.', { ...enumOf('day', 'week', 'month', 'repo'), default: 'week' }),
      ...PAGE,
    ],
    response: { status: 200, schema: list(ref('PullRequest'), true) }, textFormats: true,
    example: 'state=merged&who=me&from=-30d&format=md',
  },
  {
    method: 'get', path: '/api/v1/prs/{repo}/{number}', tag: 'Lists', summary: 'One pull request with commits and linked issues',
    params: [p('repo', 'Repo name'), p('number', 'PR number', int())], response: { status: 200, schema: ref('PullRequestDetail') },
  },
  {
    method: 'get', path: '/api/v1/activity', tag: 'Lists', summary: 'Activity feed (commits without a PR, PR/issue events, releases, stars)',
    description: 'Sorted by at desc. facets.byRepo ignores repos; facets.byType ignores types. format=md groups one bullet per event by day.',
    params: [...SCOPE, q('types', 'Comma-separated event types: commit, pr, issue, release, star. Default: all.', str(), 'pr,release'), ...PAGE],
    response: { status: 200, schema: list(ref('ActivityEvent'), true) }, textFormats: true, example: 'from=-7d&types=pr,release',
  },
  { method: 'get', path: '/api/v1/commits', tag: 'Lists', summary: 'Commits to default branches (including PR merges)', params: [...SCOPE, ...PAGE], response: { status: 200, schema: list(ref('Commit')) }, textFormats: true, example: 'who=me&from=-7d' },
  {
    method: 'get', path: '/api/v1/issues', tag: 'Lists', summary: 'Issues (dated by closedAt when closed, else createdAt)',
    params: [...SCOPE, q('state', 'Issue state.', { ...enumOf('open', 'closed', 'all'), default: 'all' }), ...PAGE],
    response: { status: 200, schema: list(ref('Issue')) }, textFormats: true,
  },
  { method: 'get', path: '/api/v1/releases', tag: 'Lists', summary: 'Published releases', params: [...SCOPE, ...PAGE], response: { status: 200, schema: list(ref('Release')) }, textFormats: true, example: 'from=-90d' },
  { method: 'get', path: '/api/v1/stars', tag: 'Lists', summary: 'People starring your repos', params: [...SCOPE, ...PAGE], response: { status: 200, schema: list(ref('Star')) }, textFormats: true },
  {
    method: 'get', path: '/api/v1/stats', tag: 'Stats', summary: 'Tiles, zero-filled series, cumulative stars, commit calendar, per-repo and contributor totals',
    params: [...SCOPE, q('bucket', "Default: 'day' if range <= 45 days, 'week' if <= 190, else 'month'.", enumOf('day', 'week', 'month'))],
    response: { status: 200, schema: ref('StatsResponse') }, example: 'from=-90d&tz=UTC',
  },
  { method: 'get', path: '/api/v1/repos', tag: 'Repos', summary: 'All repos (incl. archived, hidden, forks) with stats', response: { status: 200, schema: obj({ items: arr(ref('Repo')) }) } },
  { method: 'get', path: '/api/v1/repos/{name}', tag: 'Repos', summary: 'One repo', params: [p('name', 'Repo name')], response: { status: 200, schema: ref('Repo') } },
  {
    method: 'patch', path: '/api/v1/repos/{name}', tag: 'Repos', summary: 'Pin/unpin or hide/unhide a repo (local preference)',
    params: [p('name', 'Repo name')], body: { schema: obj({ pinned: bool, hidden: bool }, ['pinned', 'hidden']), example: { pinned: true } },
    response: { status: 200, schema: ref('Repo') },
  },
  { method: 'get', path: '/api/v1/sets', tag: 'Sets & views', summary: 'Repo sets', response: { status: 200, schema: obj({ items: arr(ref('RepoSet')) }) } },
  {
    method: 'post', path: '/api/v1/sets', tag: 'Sets & views', summary: 'Create a repo set (unknown repos are ignored)',
    body: { schema: obj({ name: str(), repos: arr(str()) }), example: { name: 'Tools', repos: ['app', 'tools'] } },
    response: { status: 200, schema: ref('RepoSet') },
  },
  {
    method: 'patch', path: '/api/v1/sets/{id}', tag: 'Sets & views', summary: 'Rename a set or replace its repos',
    params: [p('id', 'Set id', int())], body: { schema: obj({ name: str(), repos: arr(str()) }, ['name', 'repos']), example: { name: 'Work' } },
    response: { status: 200, schema: ref('RepoSet') },
  },
  { method: 'delete', path: '/api/v1/sets/{id}', tag: 'Sets & views', summary: 'Delete a set', params: [p('id', 'Set id', int())], response: { status: 204, description: 'Deleted' } },
  { method: 'get', path: '/api/v1/views', tag: 'Sets & views', summary: 'Saved views', response: { status: 200, schema: obj({ items: arr(ref('SavedView')) }) } },
  {
    method: 'post', path: '/api/v1/views', tag: 'Sets & views', summary: 'Save a view (app path + query)',
    body: { schema: obj({ name: str(), path: str(), query: str() }), example: { name: 'My merged PRs', path: '/prs', query: 'state=merged&who=me&range=30d' } },
    response: { status: 200, schema: ref('SavedView') },
  },
  { method: 'delete', path: '/api/v1/views/{id}', tag: 'Sets & views', summary: 'Delete a saved view', params: [p('id', 'View id', int())], response: { status: 204, description: 'Deleted' } },
  { method: 'get', path: '/api/v1/sync/status', tag: 'Sync', summary: 'Sync progress, last result, next run and rate limit', response: { status: 200, schema: ref('SyncStatus') } },
  {
    method: 'post', path: '/api/v1/sync', tag: 'Sync', summary: 'Start a sync now (409 if one is running)',
    description: '`repo` limits the sync to one repo; `full` ignores high-water marks, re-fetches the backfill window and re-diffs stars.',
    body: { schema: obj({ repo: str(), full: bool }, ['repo', 'full']), example: { full: true }, optional: true },
    response: { status: 202, schema: ref('SyncStatus') },
  },
  { method: 'get', path: '/api/v1/settings', tag: 'Settings', summary: 'Settings', response: { status: 200, schema: ref('Settings') } },
  {
    method: 'patch', path: '/api/v1/settings', tag: 'Settings', summary: 'Update settings (partial)',
    body: { schema: { ...ref('Settings') }, example: { syncIntervalMinutes: 60, myEmails: ['me@example.com'] } },
    response: { status: 200, schema: ref('Settings') },
  },
  { method: 'get', path: '/api/v1/openapi.json', tag: 'System', summary: 'This document', response: { status: 200, description: 'OpenAPI 3.1 JSON' } },
  { method: 'get', path: '/api/docs', tag: 'System', summary: 'Human-readable API docs', response: { status: 200, description: 'HTML' } },
];

export function openApiDocument(version: string): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const e of ENDPOINTS) {
    const responses: Record<string, Schema> = {
      [e.response.status]: e.response.schema
        ? {
            description: 'OK',
            content: {
              'application/json': { schema: e.response.schema },
              ...(e.textFormats ? { 'text/markdown': { schema: str() }, 'text/csv': { schema: str() } } : {}),
            },
          }
        : { description: e.response.description ?? 'OK' },
    };
    if (e.path.startsWith('/api/v1/')) {
      responses.default = { description: 'Error', content: { 'application/json': { schema: ref('Error') } } };
    }
    (paths[e.path] ??= {})[e.method] = {
      tags: [e.tag],
      summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      ...(e.params ? { parameters: e.params.map(({ example, ...param }) => (example ? { ...param, example } : param)) } : {}),
      ...(e.body ? { requestBody: { required: !e.body.optional, content: { 'application/json': { schema: e.body.schema, example: e.body.example } } } } : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'gh-dash API',
      version,
      description:
        'Read-only dashboard of GitHub activity across your own repositories. Timestamps are ISO-8601 UTC. ' +
        'When GH_DASH_API_KEY is set, send `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    },
    servers: [{ url: '/' }],
    components: {
      schemas,
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
    security: [{}, { bearer: [] }, { apiKey: [] }],
    paths,
  };
}
