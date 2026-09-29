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

const TOKEN_SOURCE = enumOf('env', 'file', 'gh-cli', 'app', 'none');
/** An instance setting with where it came from. */
const setting = (value: Schema): Schema => obj({ value, source: enumOf('default', 'file', 'env') });

const schemas: Record<string, Schema> = {
  Error: obj({ error: str(), details: {} }, ['details']),
  Actor: obj({ login: nullable(str()), name: nullable(str()), avatarUrl: nullable(str()), isMe: bool }),
  Label: obj({ name: str(), color: str('Hex without #') }),
  RepoStats: obj({
    openPrs: int(), openIssues: int(), mergedPrs30d: int(), commits30d: int(), newStars30d: int(),
    weeklyCommits: { ...arr(int()), description: '12 Mon-start weeks (server tz), oldest first' },
  }),
  Repo: obj({
    key: str('Identity in URLs, `repos=` lists and every `repo` field: owner/name on github.com, <host>/<path> on other sources'),
    source: str('Host of the source the repo is on: github.com, or a GitLab host'), provider: enumOf('github', 'gitlab'),
    name: str('Short name'), nameWithOwner: str(), owner: str(), description: nullable(str()), url: str(),
    visibility: enumOf('public', 'private', 'internal'), isArchived: bool, isFork: bool,
    language: nullable(obj({ name: str(), color: nullable(str()) })), topics: arr(str()), defaultBranch: nullable(str()),
    stars: int(), forks: int(), createdAt: dateTime, pushedAt: nullable(dateTime), lastActivityAt: nullable(dateTime),
    pinned: bool, hidden: bool, setIds: arr(int()), stats: ref('RepoStats'), syncedAt: nullable(dateTime),
    trackedBy: { ...enumOf('owned', 'manual'), description: 'owned: one of your repositories, tracked automatically; manual: added by hand' },
    addedAt: { ...nullable(dateTime), description: 'Manual repos: when they were added' },
    unavailable: {
      ...nullable(obj({ since: dateTime, reason: str() })),
      description: 'Manual repos the token can no longer read: data kept, sync skips it until readable again',
    },
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
    diffCacheMb: { ...int(), minimum: 10, maximum: 10000, description: 'Diff cache size cap in MB' },
  }, ['myEmailsFromEnv']),
  Me: obj({ login: str(), name: nullable(str()), avatarUrl: nullable(str()), tokenSource: enumOf('env', 'file', 'gh-cli', 'app', 'none') }),
  SyncStatus: obj({
    running: bool,
    trigger: nullable(enumOf('manual', 'scheduled', 'startup')),
    progress: nullable(obj({ done: int(), total: int(), current: nullable(str()) })),
    lastSyncAt: nullable(dateTime),
    lastSyncDurationMs: nullable(int()),
    lastResult: nullable(obj({ newItems: int(), errors: arr(str()) })),
    nextSyncAt: nullable(dateTime),
    rateLimit: nullable(obj({ limit: int(), remaining: int(), resetAt: dateTime })),
    tokenSource: enumOf('env', 'file', 'gh-cli', 'app', 'none'),
    viewer: nullable(str()),
    repo: { ...nullable(str()), description: 'Key of the one repository a single-repo sync is syncing (e.g. one just added); null for a full sync' },
  }, ['repo']),
  RepoCandidate: obj({
    key: str('owner/name'), owner: str(), name: str(), description: nullable(str()), visibility: enumOf('public', 'private', 'internal'),
    isArchived: bool, isFork: bool, stars: int(), pushedAt: nullable(dateTime),
    tracked: { ...nullable(enumOf('owned', 'manual')), description: 'How it is tracked already; null when it is not' },
  }),
  RepoCandidatesResponse: obj({
    items: { ...arr(ref('RepoCandidate')), description: 'Repositories you collaborate on or reach through an organization, most recently pushed first (at most 1000)' },
    suggested: { ...arr(ref('RepoCandidate')), description: 'Untracked repositories of others you recently contributed to' },
    truncated: { ...bool, description: 'More repositories exist than items lists' },
    fetchedAt: dateTime,
  }),
  RepoPreview: {
    allOf: [ref('RepoCandidate'), obj({
      url: str(), openPrs: int(), openIssues: int(),
      owned: { ...bool, description: 'You own it: tracked automatically, so it cannot be added' },
      hidden: { ...nullable(bool), description: 'When tracked: left out of the default selection' },
      backfill: {
        ...obj({ since: dateTime, commits: nullable(int()), prs: nullable(int()), issues: nullable(int()), releases: int(), requests: nullable(int()) }),
        description: 'What the first sync would fetch since `since` (null: unknown), and about how many GitHub requests',
      },
    })],
  },
  RepoLookup: {
    oneOf: [
      obj({ ok: { type: 'boolean', const: true }, repo: ref('RepoPreview') }),
      obj({
        ok: { type: 'boolean', const: false }, key: str(),
        problem: { ...enumOf('not-found', 'sso', 'org-policy', 'permission'), description: "not-found: doesn't exist, or the token can't see it; sso: the organization requires SAML single sign-on; org-policy: an organization policy refuses the token; permission: the token sees the repository but not its pull requests, issues or code" },
        message: str(), hint: nullable(str('What to do about it, for this kind of token')),
      }),
    ],
  },
  AddRepoResponse: obj({ repo: ref('Repo'), sync: { ...enumOf('started', 'queued'), description: 'queued: after the sync that is running' } }),
  AccountStatus: obj({
    source: { ...TOKEN_SOURCE, description: 'Where the token comes from right now' },
    choice: nullable(enumOf('auto', 'gh', 'file', 'app')),
    locked: { ...bool, description: "GITHUB_TOKEN is set in the environment: the source can't be changed from the app" },
    login: nullable(str('Account the token belongs to (from the last validation)')),
    name: nullable(str()),
    avatarUrl: nullable(str()),
    dbLogin: nullable(str('Account this database was synced for')),
    mismatch: { ...bool, description: 'The token is for another account than the database; syncs are refused' },
    kind: nullable(enumOf('fine-grained', 'classic', 'oauth', 'app', 'unknown')),
    expiresAt: nullable({ ...dateTime, description: "When the token expires; null if it doesn't or it's unknown" }),
    scopes: nullable({ ...arr(str()), description: 'Classic and OAuth tokens only' }),
    repos: nullable(obj({ total: int(), private: int() })),
    error: nullable(str('Why there is no usable token, or why validation failed')),
    gh: obj({ available: bool, path: nullable(str()), login: nullable(str("gh's active github.com login (from its hosts.yml)")) }),
    tokenFile: nullable(str('Configured token file (never its contents)')),
    checkedAt: nullable(dateTime),
  }),
  InstanceInfo: obj({
    version: str(),
    desktop: { ...bool, description: 'Running inside the desktop app' },
    apiUrl: nullable(str('Base URL other clients can use for this API; null when nothing listens on the network')),
    auth: obj({ password: bool, apiKey: bool }),
    configPath: nullable(str('config.json path, whether or not it exists')),
    settings: obj({
      host: setting(str()),
      port: setting(int()),
      dbPath: setting(str()),
      cacheDbPath: setting(str()),
      sync: setting(bool),
      allowedHosts: setting(arr(str())),
      tokenFile: setting(nullable(str())),
      defaultTz: setting(str()),
    }),
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
  DiffFile: obj({
    path: str('Path on the new side (for a removed file, the path it had)'),
    previousPath: nullable(str('Old path of a renamed or copied file')),
    status: enumOf('added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'),
    additions: int(),
    deletions: int(),
    patch: nullable(str('Unified-diff hunks as GitHub returns them, starting at the first "@@" line (no diff/---/+++ headers). null for binary files and diffs too large for the API.')),
  }),
  Diff: obj({
    kind: enumOf('pr', 'commit'),
    repo: str(),
    number: nullable(int('PR number; null for commits')),
    title: str('PR title or commit headline'),
    baseOid: nullable(str('Old side of every file: the merge base for a PR, the first parent for a commit (null for a root commit)')),
    headOid: str('New side of every file: the PR head, or the commit itself'),
    files: { ...arr(ref('DiffFile')), description: "In GitHub's order; at most 3000" },
    totalFiles: int('Files GitHub reports as changed; exceeds files.length when GitHub caps the list'),
    additions: int(),
    deletions: int(),
    fetchedAt: { ...dateTime, description: 'When the diff was fetched from GitHub (earlier than the request when cached)' },
    url: str('The PR\'s "Files changed" tab or the commit page on GitHub'),
    stale: {
      ...bool,
      const: true,
      description: "Present on a cached PR diff served because GitHub couldn't be asked whether it is still current (no token, rate limit, outage); never with refresh=1",
    },
  }, ['stale']),
  DiffCacheStats: obj({
    entries: int(),
    bytes: int('Bytes used by cached diffs and file contents (compressed)'),
    maxBytes: int('Current cap (settings.diffCacheMb in bytes)'),
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
const REPO = { ...p('repo', 'Repo key `owner/name`, URL-encoded as one segment (`owner%2Fname`); a bare name selects the repository of that name you own.'), example: 'kcosr%2Fgh-dash' };

const SCOPE: ParamDoc[] = [
  q('repos', 'Comma-separated repo keys (owner/name; the short name of a repo you own also works). Omitted: the default selection (non-archived, non-hidden, non-fork unless includeForks). Empty (`repos=`): no repos.', str(), 'kcosr/gh-dash,kcosr/tools'),
  q('visibility', 'Repo visibility filter (internal: GitHub Enterprise).', { ...enumOf('all', 'public', 'private', 'internal'), default: 'all' }),
  q('ownership', 'mine: repositories you own (tracked automatically); others: repositories added by hand.', { ...enumOf('all', 'mine', 'others'), default: 'all' }),
  q('who', "'me' = the authenticated user of each item's own source (its account's login or commit emails, plus settings.myEmails or GH_DASH_MY_EMAILS on every source); stars are always by others.", { ...enumOf('me', 'others', 'everyone'), default: 'everyone' }, 'me'),
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
  /** `type`: the response content type when it isn't JSON. */
  response: { status: number; schema?: Schema; description?: string; type?: string };
  textFormats?: boolean;
  example?: string;
}

export const ENDPOINTS: EndpointDoc[] = [
  { method: 'get', path: '/api/health', tag: 'System', summary: 'Liveness check (never requires auth)', response: { status: 200, schema: obj({ ok: bool, version: str() }) } },
  { method: 'get', path: '/api/v1/me', tag: 'System', summary: 'Authenticated GitHub user and token source', response: { status: 200, schema: ref('Me') } },
  {
    method: 'get', path: '/api/v1/account', tag: 'System', summary: 'The GitHub account behind the token (never the token)',
    description: 'Never calls GitHub: a new token is validated in the background (1 GraphQL point) and shown once that is done.',
    response: { status: 200, schema: ref('AccountStatus') },
  },
  {
    method: 'post', path: '/api/v1/account/check', tag: 'System', summary: 'Resolve the token again and re-validate it against GitHub',
    response: { status: 200, schema: ref('AccountStatus') },
  },
  {
    method: 'get', path: '/api/v1/instance', tag: 'System', summary: 'Version, API address and instance settings with their sources',
    description: 'Secrets are never included, only whether a password and API key are set.',
    response: { status: 200, schema: ref('InstanceInfo') },
  },
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
    params: [REPO, p('number', 'PR number', int())], response: { status: 200, schema: ref('PullRequestDetail') },
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
  { method: 'get', path: '/api/v1/repos', tag: 'Repos', summary: 'Repository inventory or a filtered selection', params: [
    q('repos', 'Comma-separated repo keys (or short names of repos you own); explicit empty selects nothing. Overrides scope.'),
    q('scope', 'all (default) returns the inventory; default returns the default selection, which leaves out archived and hidden repos, and forks unless enabled in settings.', enumOf('all', 'default')),
    q('visibility', 'Repository visibility (internal: GitHub Enterprise)', enumOf('all', 'public', 'private', 'internal')),
    q('ownership', 'mine: repositories you own; others: repositories added by hand', enumOf('all', 'mine', 'others')),
    q('q', 'Case-insensitive substring in owner/name, description, topics or language'),
    q('sort', 'Sort within pinned/hidden groups; default activity', enumOf('activity', 'stars', 'open', 'name')),
  ], response: { status: 200, schema: obj({ items: arr(ref('Repo')) }) } },
  { method: 'get', path: '/api/v1/repos/{repo}', tag: 'Repos', summary: 'One repo', params: [REPO], response: { status: 200, schema: ref('Repo') } },
  {
    method: 'get', path: '/api/v1/repo-candidates', tag: 'Repos', summary: 'Repositories of others the token can read, to add',
    description: 'Cached for 5 minutes per token. Costs up to 10 REST requests and 1 GraphQL point. 503 without a token, 409 when the token is for another account than this database.',
    params: [q('refresh', "'1' asks GitHub again instead of using the cache.", enumOf('1'))],
    response: { status: 200, schema: ref('RepoCandidatesResponse') },
  },
  {
    method: 'get', path: '/api/v1/repo-lookup', tag: 'Repos', summary: 'Whether the token can read a repository, with a preview',
    description: 'One GraphQL request. `ok: false` explains why the token can\'t read it (200). 400 for input that names no GitHub repository, 503 without a token, 409 when the token is for another account, 429 rate limited.',
    params: [{ ...q('repo', 'owner/name, a github.com URL (https or git@)', str(), 'dlvhdr/gh-dash'), required: true }],
    response: { status: 200, schema: ref('RepoLookup') },
  },
  {
    method: 'post', path: '/api/v1/repos', tag: 'Repos', summary: "Track a repository you don't own, and start its first sync",
    description:
      'Checks access again first. 400 bad input; 404 `{ details: { problem: "not-found", hint } }`; 403 `{ details: { problem: "sso" | "org-policy" | "permission", hint } }`; ' +
      '409 `{ details: { key, trackedBy, hidden } }` when you own it (tracked automatically) or it is tracked already, or when the token is for another account; 503 without a token; 429 rate limited.',
    body: {
      schema: obj({ repo: str('owner/name or a github.com URL'), includeInDefault: { ...bool, default: true, description: 'Include in the default selection (hidden: false)' } }, ['includeInDefault']),
      example: { repo: 'dlvhdr/gh-dash' },
    },
    response: { status: 201, schema: ref('AddRepoResponse') },
  },
  {
    method: 'delete', path: '/api/v1/repos/{repo}', tag: 'Repos', summary: 'Stop tracking a repository you added',
    description: 'Deletes its pull requests, issues, commits, releases and cached diffs from this dashboard, and its set memberships. Nothing changes on GitHub. 409 for a repository you own (hide it instead), 404 when unknown.',
    params: [REPO], response: { status: 204, description: 'Removed' },
  },
  {
    method: 'patch', path: '/api/v1/repos/{repo}', tag: 'Repos', summary: 'Pin/unpin or hide/unhide a repo (local preference)',
    params: [REPO], body: { schema: obj({ pinned: bool, hidden: bool }, ['pinned', 'hidden']), example: { pinned: true } },
    response: { status: 200, schema: ref('Repo') },
  },
  { method: 'get', path: '/api/v1/sets', tag: 'Sets & views', summary: 'Repo sets', response: { status: 200, schema: obj({ items: arr(ref('RepoSet')) }) } },
  {
    method: 'post', path: '/api/v1/sets', tag: 'Sets & views', summary: 'Create a repo set (unknown repos are ignored)',
    body: { schema: obj({ name: str(), repos: arr(str('Repo key, or the short name of a repo you own')) }), example: { name: 'Tools', repos: ['kcosr/app', 'kcosr/tools'] } },
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
    description: 'Repo references (`repos`, `pr`, `diff` and a `/repos/...` path) are stored as keys; other params are kept as sent.',
    body: { schema: obj({ name: str(), path: str(), query: str() }), example: { name: 'My merged PRs', path: '/prs', query: 'state=merged&who=me&range=30d' } },
    response: { status: 200, schema: ref('SavedView') },
  },
  { method: 'delete', path: '/api/v1/views/{id}', tag: 'Sets & views', summary: 'Delete a saved view', params: [p('id', 'View id', int())], response: { status: 204, description: 'Deleted' } },
  {
    method: 'get', path: '/api/v1/prs/{repo}/{number}/diff', tag: 'Diffs', summary: "A pull request's changes against its merge base",
    description:
      'Fetched from GitHub on first view and cached. While the last sync shows the same head and base branch and no update since, ' +
      'it is served without a GitHub request (open PRs are re-checked hourly, as the merge base can move). ' +
      "When that re-check fails with 503, 429 or 502, a cached copy that matches the last sync's head and base branch is served " +
      'instead, with `stale: true` (not with refresh=1). ' +
      'Errors: 404 unknown repo or PR, 503 no GitHub token, 429 GitHub rate limit (details.resetAt), 502 other GitHub failures, ' +
      '403 for cross-site browser requests.',
    params: [
      REPO, p('number', 'PR number', int()),
      q('refresh', "'1' re-checks the PR on GitHub (head, merge base, title) instead of trusting the last sync; files are fetched again only if the head or merge base changed.", enumOf('1')),
    ],
    response: { status: 200, schema: ref('Diff') },
  },
  {
    method: 'get', path: '/api/v1/commits/{repo}/{oid}/diff', tag: 'Diffs', summary: "A commit's changes against its first parent",
    description: 'The commit need not be synced (e.g. PR branch commits), but the repo must be. Errors as for PR diffs.',
    params: [REPO, p('oid', 'Commit SHA or an abbreviation of one, 7-64 hex characters (a SHA-1 is 40, a SHA-256 is 64)'), q('refresh', "'1' fetches it again instead of using the cache.", enumOf('1'))],
    response: { status: 200, schema: ref('Diff') },
  },
  {
    method: 'get', path: '/api/v1/blob/{repo}', tag: 'Diffs', summary: 'File contents at a commit (for expanding diff context)',
    description: 'Errors: 400 invalid ref or path, 404 no such file, 413 larger than 5 MB, 415 binary file.',
    params: [REPO, { ...q('ref', 'Commit SHA or an abbreviation of one, 7-64 hex characters (a SHA-1 is 40, a SHA-256 is 64)'), required: true }, { ...q('path', 'File path in the repo'), required: true }],
    response: { status: 200, schema: str(), type: 'text/plain' },
    example: 'ref=0123abc&path=README.md',
  },
  { method: 'get', path: '/api/v1/diff-cache', tag: 'Diffs', summary: 'Diff cache size', response: { status: 200, schema: ref('DiffCacheStats') } },
  { method: 'delete', path: '/api/v1/diff-cache', tag: 'Diffs', summary: 'Empty the diff cache and release its disk space', response: { status: 200, schema: ref('DiffCacheStats') } },
  { method: 'get', path: '/api/v1/sync/status', tag: 'Sync', summary: 'Sync progress, last result, next run and rate limit', response: { status: 200, schema: ref('SyncStatus') } },
  {
    method: 'post', path: '/api/v1/sync', tag: 'Sync', summary: 'Start a sync now (409 if one is running)',
    description:
      '`repo` (a key, or the short name of a repo you own) limits the sync to one repo (404 when a key names no tracked repository: add it first); `full` ignores high-water marks, re-fetches the backfill window and re-diffs stars. ' +
      'The token is resolved afresh; without one the answer is 503 with the reason.',
    body: { schema: obj({ repo: str(), full: bool }, ['repo', 'full']), example: { full: true }, optional: true },
    response: { status: 202, schema: ref('SyncStatus') },
  },
  { method: 'get', path: '/api/v1/settings', tag: 'Settings', summary: 'Settings', response: { status: 200, schema: ref('Settings') } },
  {
    method: 'patch', path: '/api/v1/settings', tag: 'Settings', summary: 'Update settings (partial)',
    body: { schema: { ...ref('Settings') }, example: { syncIntervalMinutes: 60, myEmails: ['me@example.com'] } },
    response: { status: 200, schema: ref('Settings') },
  },
  { method: 'get', path: '/api/v1/openapi.json', tag: 'System', summary: 'This document (never requires auth)', response: { status: 200, description: 'OpenAPI 3.1 JSON' } },
  { method: 'get', path: '/api/docs', tag: 'System', summary: 'Human-readable API docs (never requires auth)', response: { status: 200, description: 'HTML' } },
];

export function openApiDocument(version: string): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const e of ENDPOINTS) {
    const responses: Record<string, Schema> = {
      [e.response.status]: e.response.schema
        ? {
            description: 'OK',
            content: {
              [e.response.type ?? 'application/json']: { schema: e.response.schema },
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
        'When GH_DASH_API_KEY is set, send `Authorization: Bearer <key>` or `X-API-Key: <key>`. ' +
        'The server answers only requests addressed to localhost, an IP address or a name in GH_DASH_ALLOWED_HOSTS (else 421).',
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
