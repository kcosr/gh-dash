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

/** github.com's credential (AccountStatus, Me, SyncStatus): gh or a token file, never glab. */
const TOKEN_SOURCE = enumOf('env', 'file', 'gh-cli', 'app', 'none');
/** Any source's credential (SourceAccount, SourceSyncStatus): glab is for GitLab sources. */
const SOURCE_TOKEN_SOURCE = enumOf('env', 'file', 'gh-cli', 'glab', 'app', 'none');
/** An instance setting with where it came from. */
const setting = (value: Schema): Schema => obj({ value, source: enumOf('default', 'file', 'env') });

/**
 * A new thread's request body. A PR or branch thread must name the head it was made on (a PR's or branch's head moves);
 * a commit thread is on the commit.
 */
function newThread(kind: 'pr' | 'branch' | 'commit'): Schema {
  const anchor = ['baseOid', 'path', 'side', 'startLine', 'endLine', 'snippet'];
  return {
    ...obj({
      commitOid: str(kind === 'commit' ? "Optional; if sent, the commit's own full SHA" : 'headOid of the diff shown (full SHA)'),
      baseOid: nullable(str("The diff's baseOid")),
      path: nullable(str()),
      side: nullable(enumOf('old', 'new')),
      startLine: nullable(int()),
      endLine: nullable(int()),
      snippet: nullable(str()),
      body: str('Markdown, at most 65536 characters'),
    }, kind === 'commit' ? ['commitOid', ...anchor] : anchor),
    description:
      'Anchor levels: no path (the whole PR, branch or commit); path only (a file); or path, side, startLine, endLine and snippet ' +
      '(lines, at most 1000, snippet holding exactly those lines).',
  };
}

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
    commentCount: { ...int(), description: 'Local comments on its pull requests, branches and commits (every author): removing the repo deletes them too' },
  }),
  PullRequest: obj({
    id: str('<repo>#<number>'), repo: str(), number: int(), title: str(), body: str('Markdown'),
    state: enumOf('open', 'merged', 'closed'), isDraft: bool, author: ref('Actor'), mergedBy: nullable(str()),
    createdAt: dateTime, updatedAt: dateTime, mergedAt: nullable(dateTime), closedAt: nullable(dateTime),
    activityAt: { ...dateTime, description: 'mergedAt if merged, closedAt if closed, else createdAt' },
    additions: int(), deletions: int(), changedFiles: int(), commitCount: int(), headRef: str(), baseRef: str(),
    labels: arr(ref('Label')), url: str(),
    comments: {
      ...ref('CommentCounts'),
      description:
        "Local comment threads its view shows: its own, and its branch's group (see the per-PR thread list; zero counts when none), on list items, the detail and activity events alike",
    },
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
    comments: { ...ref('CommentCounts'), description: 'Local comment threads on this commit itself (not on a PR it landed through, or a branch; zero counts when none), on list items and activity events alike' },
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
      obj({
        type: enumOf('comment'), kind: ref('CommentEventKind'), at: dateTime, repo: str(),
        actor: { ...ref('Actor'), description: 'The principal: login and avatarUrl null, isMe for the dashboard user, an agent otherwise' },
        comment: ref('CommentActivity'),
      }),
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
  SyncStatus: {
    ...obj({
      running: bool,
      trigger: nullable(enumOf('manual', 'scheduled', 'startup')),
      progress: { ...nullable(obj({ done: int(), total: int(), current: nullable(str()) })), description: "The run's progress: its sources' added up" },
      lastSyncAt: nullable(dateTime),
      lastSyncDurationMs: nullable(int()),
      lastResult: { ...nullable(obj({ newItems: int(), errors: arr(str()) })), description: "The last run's, every source's: errors name their source, but for github.com's" },
      nextSyncAt: nullable(dateTime),
      rateLimit: { ...nullable(obj({ limit: int(), remaining: int(), resetAt: dateTime })), description: "github.com's" },
      tokenSource: { ...enumOf('env', 'file', 'gh-cli', 'app', 'none'), description: "github.com's" },
      viewer: { ...nullable(str()), description: "github.com's account" },
      repo: { ...nullable(str()), description: 'Key of the one repository a single-repo sync is syncing (e.g. one just added); null for a full sync' },
      sources: { ...arr(ref('SourceSyncStatus')), description: "Every source this database knows, github.com first: each one's part of the sync" },
    }, ['repo']),
    description: 'One sync runs at a time; inside it, each source syncs on its own, concurrently.',
  },
  SourceSyncStatus: obj({
    source: str("The source's host, e.g. github.com or gitlab.example.com"),
    running: { ...bool, description: 'Its part of the current run is still going' },
    progress: nullable(obj({ done: int(), total: int(), current: nullable(str()) })),
    lastSyncAt: { ...nullable(dateTime), description: 'When its last sync (all its repositories, or one) ended' },
    lastResult: nullable(obj({ newItems: int(), errors: arr(str()) })),
    rateLimit: nullable(obj({ limit: int(), remaining: int(), resetAt: dateTime })),
    tokenSource: SOURCE_TOKEN_SOURCE,
    viewer: { ...nullable(str()), description: 'The account its data belongs to' },
    problem: {
      ...nullable(str()),
      description: "Why it isn't syncing: not configured on this server, no token (and why), or a token for another account than its data's; null when nothing stands in the way",
    },
  }),
  SourceAccount: obj({
    source: { ...SOURCE_TOKEN_SOURCE, description: 'Where the token comes from right now' },
    choice: { ...nullable(enumOf('auto', 'gh', 'glab', 'file', 'app')), description: 'The configured choice; null = nothing chosen yet (desktop app) or nothing configured' },
    locked: { ...bool, description: "`env` is set in the environment: it is always used, and the choice can't be changed from the app" },
    env: { ...nullable(str()), description: 'The variable that locks this source (GITHUB_TOKEN, a GitLab source\'s tokenEnv); null when none does' },
    login: nullable(str('Account the token belongs to (from the last validation)')),
    name: nullable(str()),
    avatarUrl: nullable(str()),
    dbLogin: nullable(str('The account this database was synced for, on this source; null before its first sync')),
    mismatch: { ...bool, description: 'The token is for another account than the source\'s data; syncs of it are refused' },
    kind: nullable(enumOf('fine-grained', 'classic', 'oauth', 'app', 'personal', 'unknown')),
    expiresAt: nullable({ ...dateTime, description: "When the token stops working; null if it doesn't or it's unknown (GitLab OAuth tokens)" }),
    scopes: nullable({ ...arr(str()), description: 'GitHub classic and OAuth tokens; GitLab personal access tokens. null when unknown' }),
    canWrite: { ...nullable(bool), description: 'GitLab: the scopes include api or write_repository, which gh-dash never needs. null for GitHub, or unknown' },
    repos: {
      ...nullable(obj({ total: int(), private: nullable(int()) })),
      description: 'GitHub: owned repositories (total / private). GitLab: projects in the personal namespace (private unknown)',
    },
    cli: { ...nullable(obj({ name: enumOf('gh', 'glab'), available: bool, path: nullable(str()), login: nullable(str("gh's active login (from its hosts.yml); not read for glab")) })), description: "The provider's command-line tool" },
    tokenFile: nullable(str('Configured token file (never its contents)')),
    instance: { ...nullable(obj({ version: str(), enterprise: bool })), description: "The GitLab instance's version; null for GitHub, or before a validation" },
    error: nullable(str('Why there is no usable token, or why validation failed')),
    checkedAt: nullable(dateTime),
  }),
  Source: obj({
    host: str("Identity: github.com, or a GitLab host. Also `Repo.source` and `SourceSyncStatus.source`, and the id in /sources/{source}"),
    kind: enumOf('github', 'gitlab'),
    name: str("Display name: 'GitHub', 'GitLab', or the host when there are several GitLab sources"),
    url: str('Base URL of the instance, relative root included'),
    configured: { ...bool, description: "This server syncs it: github.com always, a GitLab source when this server's config (config.json / the environment) names it" },
    removable: { ...bool, description: 'DELETE would remove it now: not github.com, and not while it is configured on this server' },
    viewer: { ...nullable(obj({ login: str(), name: nullable(str()), avatarUrl: nullable(str()) })), description: 'The account its data belongs to (claimed by its first sync); null before that' },
    account: { anyOf: [ref('SourceAccount'), { type: 'null' }], description: "Its credential as this server holds it, never the token; null when the source isn't configured here" },
    sync: ref('SourceSyncStatus'),
    repos: { ...obj({ owned: int(), added: int(), hidden: int() }), description: 'Live repositories on it: tracked automatically, added by hand, and (of both) hidden from the default selection' },
  }),
  RepoCandidate: obj({
    key: str('Repo key: owner/name on github.com, <host>/<path> on other sources'), owner: str('Owner, or GitLab namespace path'), name: str(), description: nullable(str()), visibility: enumOf('public', 'private', 'internal'),
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
        description: "What the first sync would fetch since `since` (null: unknown; GitLab doesn't count commits), and about how many requests to the code host",
      },
      unavailable: {
        ...arr(enumOf('prs', 'issues')),
        description: "Parts the code host doesn't show this token, though it can be added (GitLab: merge requests or issues turned off, or hidden at the token's role); nothing of them is synced. Absent when all are there.",
      },
    }, ['unavailable'])],
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
      glabPath: { ...setting(nullable(str())), description: "The glab executable, when it isn't on PATH or in a standard location (GitLab sources)" },
      sources: {
        ...arr(obj({ host: str(), from: enumOf('default', 'file', 'env') })),
        description: 'The GitLab sources this server is configured with, and where each came from: config.json (file), or GH_DASH_GITLAB_URL (env)',
      },
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
    patch: nullable(str('Unified-diff hunks as the code host returns them, starting at the first "@@" line (no diff/---/+++ headers). null for binary files and diffs too large for the API.')),
  }),
  Diff: obj({
    kind: enumOf('pr', 'commit', 'branch'),
    repo: str(),
    number: nullable(int('PR number; null for commits and branches')),
    branch: str("For kind 'branch': the branch, compared against baseRef. Absent otherwise."),
    baseRef: str("For kind 'branch': the repo's default branch, which the branch is compared against. Absent otherwise."),
    title: str("PR title, commit headline, or the branch's name"),
    baseOid: nullable(str('Old side of every file: the merge base for a PR or branch (three-dot), the first parent for a commit (null for a root commit)')),
    headOid: str("New side of every file: the PR head, the commit itself, or the branch's head"),
    files: { ...arr(ref('DiffFile')), description: "In the code host's order; GitHub lists at most 3000" },
    totalFiles: int('Files the code host reports as changed; exceeds files.length when it caps the list'),
    additions: int(),
    deletions: int(),
    fetchedAt: { ...dateTime, description: 'When the diff was fetched from the code host (earlier than the request when cached)' },
    url: str('The PR\'s "Files changed" tab (GitLab: the merge request\'s changes page), the commit page, or the branch\'s compare page on the code host'),
    stale: {
      ...bool,
      const: true,
      description: "Present on a cached PR or branch diff served because the code host couldn't be asked whether it is still current (no token, rate limit, outage); never with refresh=1",
    },
  }, ['stale', 'branch', 'baseRef']),
  BranchSummary: obj({
    name: str(),
    headOid: str('The commit the branch points to'),
    committedAt: nullable({ ...dateTime, description: "The head commit's committer date; null when the code host doesn't say" }),
    pr: nullable(obj({ number: int(), state: enumOf('open', 'merged', 'closed'), title: str() })),
  }),
  BranchListResponse: obj({
    items: { ...arr(ref('BranchSummary')), description: 'Newest head commit first; the default branch is left out. `pr` is the newest synced PR from the same repo with this branch as its head, of any state: a branch with an open PR is usually reviewed there (its threads are shared with the branch).' },
    defaultBranch: str("The repo's default branch, as of the last sync"),
    more: { ...bool, description: 'The code host has more matching branches than were listed (at most 100): narrow them with `q`.' },
  }),
  DiffCacheStats: obj({
    entries: int(),
    bytes: int('Bytes used by cached diffs and file contents (compressed)'),
    maxBytes: int('Current cap (settings.diffCacheMb in bytes)'),
  }),
  CommentCounts: obj({ threads: int(), unresolved: int('Threads still open') }),
  Principal: obj({
    id: int('1 is the dashboard user'),
    kind: enumOf('self', 'agent'),
    name: str(),
  }),
  ThreadComment: obj({
    id: int(), author: ref('Principal'), body: str('Markdown'), createdAt: dateTime, editedAt: nullable(dateTime),
  }),
  CommentThread: obj({
    id: int(),
    kind: { ...enumOf('pr', 'branch', 'commit'), description: "What it was made on: a PR's diff, a branch's (against the default branch), or a commit's" },
    repo: str(),
    number: nullable(int('PR number; null otherwise')),
    branch: nullable(str(
      "The branch whose line of work it belongs to (its branch group): always set for kind 'branch'; for kind 'pr', the PR's head branch when the PR is " +
        'from the same repository (null for a PR from a fork, or one made before the sync knew which); null for commits',
    )),
    commitOid: str('The revision the thread was made on: the diff\'s headOid then (PR head, branch head, or the commit)'),
    baseOid: nullable(str("The diff's baseOid then (merge base or first parent)")),
    path: nullable(str('File (DiffFile.path); null for a thread on the whole PR, branch or commit')),
    side: nullable({ ...enumOf('old', 'new'), description: 'null for a file-level thread, or one on the whole PR, branch or commit' }),
    startLine: nullable(int('1-based, on side')),
    endLine: nullable(int('Inclusive')),
    snippet: nullable(str('The anchored lines as they were, joined with \\n (endLine - startLine + 1 lines)')),
    status: enumOf('open', 'resolved'),
    resolvedAt: nullable(dateTime),
    resolvedBy: { ...nullable(ref('Principal')), description: 'Who resolved it; null while open (threads resolved before gh-dash recorded it read as the dashboard user)' },
    createdAt: dateTime,
    updatedAt: { ...dateTime, description: 'Last comment added, edited or deleted, or status change' },
    comments: { ...arr(ref('ThreadComment')), description: 'Oldest first; never empty' },
  }),
  ThreadListItem: {
    allOf: [ref('CommentThread'), obj({
      targetTitle: nullable(str(
        "The PR's title or the commit's headline; null when that isn't synced (a thread can outlive its PR's row), and for a branch thread (`branch` names it). " +
          "A commit the sync doesn't hold takes its headline from a synced PR that lists it (the newest one), else null",
      )),
      prState: nullable({ ...enumOf('open', 'merged', 'closed'), description: "The PR's state; null for a branch or commit thread, or a PR that isn't synced" }),
      targetUrl: str(
        "The PR or commit on its code host (the synced row's url, else built from the repo's url), or the branch's compare page against the default branch " +
          "(the repository's page while the default branch isn't known)",
      ),
      earlierPush: { ...bool, description: "A PR thread made on an earlier push than the PR's current head (false for branches and commits, or when the head isn't known)" },
      view: {
        oneOf: [
          obj({ kind: enumOf('pr'), number: int() }),
          obj({ kind: enumOf('branch'), branch: str() }),
          obj({ kind: enumOf('commit'), oid: str() }),
        ],
        description:
          'The diff to open the thread at: its own PR, branch or commit, except a branch thread made no later than a merge of its branch (an earlier line of work), ' +
          'which the merged PR that ended that line of work shows, while the sync holds it',
      },
    })],
  },
  NewPrThread: newThread('pr'),
  NewBranchThread: newThread('branch'),
  NewThread: newThread('commit'),
  CommentEventKind: enumOf('thread_opened', 'replied', 'edited', 'comment_deleted', 'resolved', 'reopened', 'thread_deleted'),
  CommentActivity: obj({
    eventId: int(),
    threadId: int(),
    commentId: nullable(int('The comment it is about (the first, for thread_opened); null for resolved, reopened and thread_deleted')),
    live: { ...bool, description: 'False once the thread is deleted' },
    by: ref('Principal'),
    target: {
      oneOf: [
        obj({ kind: enumOf('pr'), number: int(), title: nullable(str("The PR's title; null when not synced")) }),
        obj({ kind: enumOf('branch'), branch: str(), title: { type: 'null', description: 'None: the branch names it' } }),
        obj({ kind: enumOf('commit'), oid: str(), title: nullable(str("The commit's headline (or a synced PR's listing of it); null when not synced")) }),
      ],
    },
    commitOid: str('The revision the thread was made on'),
    path: nullable(str()),
    side: nullable(enumOf('old', 'new')),
    startLine: nullable(int()),
    endLine: nullable(int()),
    excerpt: nullable(str("Plain text, at most 280 characters: the comment's (for comment events) or the thread's first comment's (thread events). null once that comment or its thread is deleted, and on the delete events")),
    view: {
      ...nullable({
        oneOf: [
          obj({ kind: enumOf('pr'), number: int() }),
          obj({ kind: enumOf('branch'), branch: str() }),
          obj({ kind: enumOf('commit'), oid: str() }),
        ],
      }),
      description:
        'The diff that shows the thread now (as ThreadListItem.view), to open the event at: `target`, unless the thread is a branch thread of an earlier ' +
        "line of work, or has left its branch's group since. null once the thread is deleted",
    },
  }),
  Agent: obj({
    id: int("The agent's principal id (comments' author.id)"),
    name: str(),
    tokenPrefix: nullable(str("The token's first characters, to tell tokens apart (8 of a generated one, at most 4 of one the user chose); null once revoked, and for the built-in agent")),
    createdAt: dateTime,
    lastUsedAt: { ...nullable(dateTime), description: 'Last MCP request with the token (updated at most once a minute)' },
    revokedAt: nullable(dateTime),
    builtIn: { ...bool, description: 'The built-in agent "Agent" (desktop app, MCP without tokens): no token of its own' },
    sources: {
      ...nullable(arr(str())),
      description:
        'The sources it may reach through MCP, by host; null for every source, those added later included. A source deleted since is left out, and ' +
        "never widens it (none left: it reaches nothing). Out of reach, a repository reads to the agent as untracked and a thread as missing. The REST API isn't limited",
    },
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
const REPO = {
  ...p('repo', 'Repo key, URL-encoded as one segment: `owner/name` on github.com (`owner%2Fname`), `<host>/<path>` on other sources (`gitlab.example.com%2Fgroup%2Fproject`). A bare name selects the github.com repository of that name you own.'),
  example: 'kcosr%2Fgh-dash',
};
const SOURCE_PATH = { ...p('source', "The source's host: github.com, or a GitLab host such as gitlab.example.com (case-insensitive)"), example: 'gitlab.example.com' };

const SOURCE = q('source', "The source to look on, by its host; default github.com. A GitLab source must be configured on this server.", str(), 'gitlab.example.com');

const SCOPE: ParamDoc[] = [
  q('repos', 'Comma-separated repo keys (owner/name on github.com, <host>/<path> on other sources; the short name of a github.com repo you own also works). Omitted: the default selection (non-archived, non-hidden, non-fork unless includeForks). Empty (`repos=`): no repos.', str(), 'kcosr/gh-dash,kcosr/tools'),
  q('source', 'Comma-separated source hosts: only repos on those sources (the app\'s context switcher). Omitted or empty: every source. Narrows `repos` and the default selection alike. 400 for a host that isn\'t a source.', str(), 'gitlab.example.com'),
  q('visibility', 'Repo visibility filter (internal: GitHub Enterprise, and GitLab projects visible to every signed-in user).', { ...enumOf('all', 'public', 'private', 'internal'), default: 'all' }),
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
  /** Also served as text: `true` for format=md and format=csv, 'md' for format=md only. */
  textFormats?: true | 'md';
  example?: string;
}

/** Local review threads on diffs (never sent to GitHub). */
function commentEndpoints(): EndpointDoc[] {
  const tag = 'Comments';
  const repo = p('repo', 'Repo name');
  const format = q('format', "'md' returns the threads as text/markdown.", { ...enumOf('json', 'md'), default: 'json' });
  const id = (what: string) => p('id', `${what} id`, int());
  const branch = { ...p('branch', 'Branch name, URL-encoded as one segment (`fix%2Flogin`)'), example: 'fix%2Flogin' };
  const threads = obj({ items: arr(ref('CommentThread')) });
  const example = { commitOid: '0123456789abcdef0123456789abcdef01234567', path: 'src/app.ts', side: 'new', startLine: 12, endLine: 13, snippet: 'const a = 1;\nconst b = 2;', body: 'Why two?' };
  const threadList = obj({
    items: arr(ref('ThreadListItem')), nextCursor: nullable(str()), total: int('Threads matching every filter, across all pages'),
    counts: { ...obj({ open: int(), resolved: int() }), description: 'Threads per status in the same scope and filters, ignoring `status` (the status control\'s counts)' },
  });
  const listParams = [
    q('status', "'open' (unresolved) by default; 'all' for both.", { ...enumOf('open', 'resolved', 'all'), default: 'open' }),
    q('kind', 'Threads on pull requests (merge requests), on branches, on commits, or all of them.', { ...enumOf('pr', 'branch', 'commit', 'all'), default: 'all' }),
    q('sort', "By last activity (`updatedAt`): 'recent' newest first, 'oldest' the reverse. Ties by thread id in the same direction.", { ...enumOf('recent', 'oldest'), default: 'recent' }),
    q('author', "Who opened the thread (its first comment's author): 'self' (you), 'agents' (any agent), or one agent's id (GET /agents; 400 for an id nobody has). Default: anyone.", str(), 'agents'),
    q('waiting', "'you': open threads whose last comment isn't yours (someone is waiting on you).", enumOf('you')),
    ...SCOPE.filter((param) => ['repos', 'source', 'visibility', 'ownership'].includes(param.name)),
    q('q', 'Case-insensitive substring (ASCII) of any comment of the thread, or of its file path.', str(), 'typo'),
    PAGE[0]!,
    q('cursor', 'Opaque cursor from a previous nextCursor. It belongs to the `sort` it was made under (400 under the other).', str()),
    q('format', "'md' (text/markdown) returns every matching thread, ignoring limit/cursor: a section per PR, branch or commit.", { ...enumOf('json', 'md'), default: 'json' }),
  ];
  return [
    {
      method: 'get', path: '/api/v1/threads', tag, summary: 'Every comment thread in scope, across PRs, branches and commits',
      description:
        'Scoped like the PR list (source, repos, visibility, ownership; removed repositories are hidden), but not by `who` or the date range: a thread stays open however old it is. ' +
        '`who`, `from`, `to`, `range` and `tz` are accepted and ignored. Each thread carries its comments, and what it is on when that is synced. ' +
        '`counts` follow every filter but `status` (`author` and `waiting` included).',
      params: listParams, response: { status: 200, schema: threadList }, textFormats: 'md', example: 'status=open&kind=pr',
    },
    {
      method: 'get', path: '/api/v1/prs/{repo}/{number}/threads', tag, summary: "A pull request's comment threads, with their comments",
      description:
        'Oldest first. Anchors are as made; the diff viewer places them in the current diff (outdated or moved). ' +
        "Its own threads, and its branch group: for a PR from a branch of the same repository, the branch's threads (those of its review and of the " +
        "other PRs from it) made after the branch's last merge before this PR ended (merged, or closed; an open PR hasn't), up to the branch's first " +
        'merge at or after that (this PR\'s own, for a merged PR). A PR from a fork shares nothing. The group needs the PR synced; its own threads don\'t.',
      params: [repo, p('number', 'PR number', int()), format], response: { status: 200, schema: threads }, textFormats: 'md',
    },
    {
      method: 'post', path: '/api/v1/prs/{repo}/{number}/threads', tag, summary: 'Start a thread on a pull request with its first comment',
      description: 'The PR must be synced (404 otherwise). Rejected from other origins (403).',
      params: [repo, p('number', 'PR number', int())], body: { schema: ref('NewPrThread'), example }, response: { status: 200, schema: ref('CommentThread') },
    },
    {
      method: 'get', path: '/api/v1/commits/{repo}/{oid}/threads', tag, summary: "A commit's comment threads, with their comments",
      params: [repo, p('oid', 'Full commit SHA (40 characters, or 64 for SHA-256)'), format], response: { status: 200, schema: threads }, textFormats: 'md',
    },
    {
      method: 'post', path: '/api/v1/commits/{repo}/{oid}/threads', tag, summary: 'Start a thread on a commit with its first comment',
      description: 'The commit need not be synced.',
      params: [repo, p('oid', 'Full commit SHA (40 characters, or 64 for SHA-256)')], body: { schema: ref('NewThread'), example: { path: 'README.md', body: 'Typo in the intro' } },
      response: { status: 200, schema: ref('CommentThread') },
    },
    {
      method: 'get', path: '/api/v1/branches/{repo}/{branch}/threads', tag, summary: "A branch's comment threads (its review against the default branch), with their comments",
      description:
        "Oldest first. The branch's current group: its threads, and those of the PRs from it (same repository), made after the branch's last merge (all of " +
        'them, for a branch never merged). The branch need not be on the code host any more. 400 for an invalid branch name, or the default branch.',
      params: [repo, branch, format], response: { status: 200, schema: threads }, textFormats: 'md',
    },
    {
      method: 'post', path: '/api/v1/branches/{repo}/{branch}/threads', tag, summary: "Start a thread on a branch's review with its first comment",
      description:
        "Shared with the PRs from the branch until one of them is merged (see the per-PR thread list). The branch need not be on the code host any more. " +
        '400 for an invalid branch name, or the default branch. Rejected from other origins (403).',
      params: [repo, branch], body: { schema: ref('NewBranchThread'), example }, response: { status: 200, schema: ref('CommentThread') },
    },
    { method: 'get', path: '/api/v1/threads/{id}', tag, summary: 'One thread', params: [id('Thread')], response: { status: 200, schema: ref('CommentThread') } },
    {
      method: 'patch', path: '/api/v1/threads/{id}', tag, summary: 'Resolve or reopen a thread',
      params: [id('Thread')], body: { schema: obj({ status: enumOf('open', 'resolved') }), example: { status: 'resolved' } },
      response: { status: 200, schema: ref('CommentThread') },
    },
    { method: 'delete', path: '/api/v1/threads/{id}', tag, summary: 'Delete a thread and its comments', params: [id('Thread')], response: { status: 204, description: 'Deleted' } },
    {
      method: 'post', path: '/api/v1/threads/{id}/comments', tag, summary: 'Reply to a thread (its status stays as it is)',
      params: [id('Thread')], body: { schema: obj({ body: str('Markdown') }), example: { body: 'Fixed in the next push.' } },
      response: { status: 200, schema: ref('CommentThread') },
    },
    {
      method: 'patch', path: '/api/v1/comments/{id}', tag, summary: 'Edit a comment (your own only, else 403)',
      params: [id('Comment')], body: { schema: obj({ body: str('Markdown') }), example: { body: 'Why two constants?' } },
      response: { status: 200, schema: ref('CommentThread') },
    },
    {
      method: 'delete', path: '/api/v1/comments/{id}', tag, summary: 'Delete a comment; deleting the first comment deletes its thread',
      description: 'Returns the thread as it is now, or null when the thread went with its first comment.',
      params: [id('Comment')], response: { status: 200, schema: obj({ thread: nullable(ref('CommentThread')) }) },
    },
  ];
}

export const ENDPOINTS: EndpointDoc[] = [
  { method: 'get', path: '/api/health', tag: 'System', summary: 'Liveness check (never requires auth)', response: { status: 200, schema: obj({ ok: bool, version: str() }) } },
  { method: 'get', path: '/api/v1/me', tag: 'System', summary: 'The github.com account and its token source (other sources: /sources)', response: { status: 200, schema: ref('Me') } },
  {
    method: 'get', path: '/api/v1/account', tag: 'System', summary: 'The GitHub account behind the token (never the token)',
    description: "github.com's credential, as GET /sources/github.com shows it inside the source. Never calls GitHub: a new token is validated in the background (1 GraphQL point) and shown once that is done.",
    response: { status: 200, schema: ref('AccountStatus') },
  },
  {
    method: 'post', path: '/api/v1/account/check', tag: 'System', summary: 'Resolve the token again and re-validate it against GitHub',
    description: "github.com's alias of POST /sources/github.com/check, answering with the account alone (200 even without a token: `error` says why).",
    response: { status: 200, schema: ref('AccountStatus') },
  },
  {
    method: 'get', path: '/api/v1/instance', tag: 'System', summary: 'Version, API address and instance settings with their sources',
    description: 'Secrets are never included, only whether a password and API key are set.',
    response: { status: 200, schema: ref('InstanceInfo') },
  },
  {
    method: 'get', path: '/api/v1/sources', tag: 'Sources', summary: 'The code hosts repositories are tracked on',
    description:
      'github.com first, then the GitLab sources this database knows, including ones this server does not configure (`configured: false`, `account: null`). ' +
      'Never calls a provider: the credential is shown as last resolved and validated (a new token is validated in the background). ' +
      'Sources are added, and their credentials changed, in config.json or the environment (headless) or in the desktop app: not over HTTP. Tokens are never included.',
    response: { status: 200, schema: obj({ items: arr(ref('Source')) }) },
  },
  {
    method: 'get', path: '/api/v1/sources/{source}', tag: 'Sources', summary: 'One source',
    description: "404 when the host isn't a source here. Never calls a provider.",
    params: [SOURCE_PATH], response: { status: 200, schema: ref('Source') },
  },
  {
    method: 'post', path: '/api/v1/sources/{source}/check', tag: 'Sources', summary: "Resolve a source's token again and validate it now",
    description:
      'github.com: 1 GraphQL point. GitLab: 2 requests. Answers with the source, whose `account` says who the token is for, its scopes and expiry, or why it was rejected (200). ' +
      "404 when the host isn't a source here. 503 when there is no token to check (a source this server doesn't configure has none): the message says why, and `details` is the source.",
    params: [SOURCE_PATH], response: { status: 200, schema: ref('Source') },
  },
  {
    method: 'delete', path: '/api/v1/sources/{source}', tag: 'Sources', summary: 'Remove a source and everything tracked on it',
    description:
      "Deletes its repositories with their pull requests, issues, commits, releases and stars, its set memberships and its cached diffs; nothing changes on the code host. " +
      "404 when the host isn't a source here. 409 for github.com (built in), and for a source this server still has configured: remove it in Settings (desktop app), " +
      'from config.json or by unsetting GH_DASH_GITLAB_URL first (`removable` says whether DELETE would succeed).',
    params: [SOURCE_PATH], response: { status: 204, description: 'Removed' },
  },
  {
    method: 'get', path: '/api/v1/prs', tag: 'Lists', summary: 'Pull requests (merge requests on GitLab)',
    description: 'Filtered and sorted on activityAt desc (tie-break repo, number). facets.byRepo ignores the repos filter.',
    params: [
      ...SCOPE,
      q('state', 'PR state.', { ...enumOf('open', 'merged', 'closed', 'all'), default: 'all' }, 'merged'),
      q('labels', 'Comma-separated; PR must have at least one (case-insensitive).'),
      q('comments', 'Only PRs with local comment threads: any, or with at least one unresolved.', enumOf('any', 'unresolved')),
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
    params: [
      ...SCOPE.map((param) =>
        param.name === 'q' ? { ...param, description: `${param.description} Comment events: a substring (ASCII case-insensitive) of the excerpt or the file path.` }
        : param.name === 'who' ? { ...param, description: `${param.description} Comment events: me is the dashboard user, others the agents.` }
        : param),
      q('types', 'Comma-separated event types: commit, pr, issue, release, star, comment (local review comments). Default: all.', str(), 'pr,release'),
      ...PAGE,
    ],
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
    q('repos', 'Comma-separated repo keys (or short names of github.com repos you own); explicit empty selects nothing. Overrides scope.'),
    q('scope', 'all (default) returns the inventory; default returns the default selection, which leaves out archived and hidden repos, and forks unless enabled in settings.', enumOf('all', 'default')),
    q('source', 'Comma-separated source hosts: only repos on those sources. Omitted or empty: every source. 400 for a host that isn\'t a source.', str(), 'gitlab.example.com'),
    q('visibility', 'Repository visibility (internal: GitHub Enterprise, and GitLab projects visible to every signed-in user)', enumOf('all', 'public', 'private', 'internal')),
    q('ownership', 'mine: repositories you own; others: repositories added by hand', enumOf('all', 'mine', 'others')),
    q('q', 'Case-insensitive substring in the repo key, description, topics or language'),
    q('sort', 'Sort within pinned/hidden groups; default activity', enumOf('activity', 'stars', 'open', 'name')),
  ], response: { status: 200, schema: obj({ items: arr(ref('Repo')) }) } },
  { method: 'get', path: '/api/v1/repos/{repo}', tag: 'Repos', summary: 'One repo', params: [REPO], response: { status: 200, schema: ref('Repo') } },
  {
    method: 'get', path: '/api/v1/repo-candidates', tag: 'Repos', summary: 'Repositories of others the token can read, to add',
    description:
      'Cached for 5 minutes per source and token. Costs up to 10 REST requests, plus 1 GraphQL point on GitHub or 1 GraphQL request on GitLab (where projects in your personal namespace are left out: they are tracked automatically). ' +
      "400 for a source that isn't one here (or isn't configured on this server), 503 without a token, 409 when the token is for another account than this database's for that source.",
    params: [q('refresh', "'1' asks the code host again instead of using the cache.", enumOf('1')), SOURCE],
    response: { status: 200, schema: ref('RepoCandidatesResponse') },
  },
  {
    method: 'get', path: '/api/v1/repo-lookup', tag: 'Repos', summary: 'Whether the token can read a repository, with a preview',
    description:
      'One GraphQL request. `ok: false` explains why the token can\'t read it (200). 400 for input that names no repository on the source, or a host that isn\'t a source here (or isn\'t configured on this server); ' +
      '503 without a token, 409 when the token is for another account, 429 rate limited.',
    params: [{ ...q('repo', 'GitHub: owner/name or a github.com URL (https or git@). GitLab: group/…/project, its key, or a web (https) or ssh address; an address or key on another source\'s host is looked up there.', str(), 'dlvhdr/gh-dash'), required: true }, SOURCE],
    response: { status: 200, schema: ref('RepoLookup') },
  },
  {
    method: 'post', path: '/api/v1/repos', tag: 'Repos', summary: "Track a repository you don't own, and start its first sync",
    description:
      'Checks access again first. 400 bad input; 404 `{ details: { problem: "not-found", hint } }`; 403 `{ details: { problem: "sso" | "org-policy" | "permission", hint } }`; ' +
      '409 `{ details: { key, trackedBy, hidden } }` when you own it (tracked automatically) or it is tracked already, or when the token is for another account; 503 without a token; 429 rate limited.',
    body: {
      schema: obj({
        repo: str('As for /repo-lookup: owner/name or a github.com URL; on GitLab group/…/project, its key, or a web or ssh address'),
        source: { ...str(), default: 'github.com', description: "The source's host. An address or key on another source's host in `repo` wins." },
        includeInDefault: { ...bool, default: true, description: 'Include in the default selection (hidden: false)' },
      }, ['source', 'includeInDefault']),
      example: { repo: 'dlvhdr/gh-dash' },
    },
    response: { status: 201, schema: ref('AddRepoResponse') },
  },
  {
    method: 'delete', path: '/api/v1/repos/{repo}', tag: 'Repos', summary: 'Stop tracking a repository you added',
    description: 'Deletes its pull requests, issues, commits, releases and cached diffs from this dashboard, and its set memberships. Nothing changes on the code host. 409 for a repository you own (hide it instead), 404 when unknown, 400 for a source that isn\'t one here.',
    params: [REPO, q('source', "The repo's source (its host). With it, `repo` may also be the repo's path on that source (group%2Fproject), and must be on it.", str(), 'gitlab.example.com')],
    response: { status: 204, description: 'Removed' },
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
      "Fetched from the repo's code host (GitHub or GitLab, whichever `repo` is on) on first view and cached. While the last sync shows the same head and base branch and no update since, " +
      'it is served without a request to the code host (open PRs are re-checked hourly, as the merge base can move). ' +
      "When that re-check fails with 503, 429 or 502, a cached copy that matches the last sync's head and base branch is served " +
      'instead, with `stale: true` (not with refresh=1). ' +
      'Errors: 404 unknown repo or PR, 503 no token for the repo\'s source (or a source this server does not configure), 429 rate limit (details.resetAt), 502 other failures of the code host, ' +
      '403 for cross-site browser requests.',
    params: [
      REPO, p('number', 'PR number', int()),
      q('refresh', "'1' re-checks the PR on the code host (head, merge base, title) instead of trusting the last sync; files are fetched again only if the head or merge base changed.", enumOf('1')),
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
    method: 'get', path: '/api/v1/branches/{repo}', tag: 'Diffs', summary: "A repository's branches on its code host, newest first",
    description:
      "Asked of the repo's code host (GitHub or GitLab), at most 100 branches with the default branch left out, each with the PR from it if the sync has one. " +
      'GitHub cannot sort branches, so up to 500 are read to find the newest (more than that are cut off alphabetically: `more` is then true; narrow them with `q`). ' +
      'Kept in memory for a minute per repo and `q`. ' +
      "Errors: 404 unknown repo, 409 the repo's default branch isn't known yet (sync it), 503 no token for the repo's source, 429 rate limit (details.resetAt), 502 other failures of the code host, " +
      '403 for cross-site browser requests.',
    params: [
      REPO,
      q('q', 'Only branches whose name contains this (up to 255 characters; the code host matches without regard to case; GitLab also takes `^prefix` and `suffix$`).'),
      q('refresh', "'1' asks the code host again instead of using the list kept for a minute.", enumOf('1')),
    ],
    response: { status: 200, schema: ref('BranchListResponse') },
  },
  {
    method: 'get', path: '/api/v1/branches/{repo}/{branch}/diff', tag: 'Diffs', summary: "A pushed branch's changes against the repo's default branch",
    description:
      "For reviewing a branch that has no PR (yet), or before it does: the branch compared with the default branch, three-dot as a PR's is (kind `branch`; `baseOid` is the merge base). " +
      "Fetched from the repo's code host on view and cached, one diff per branch. The code host is asked for the branch's head on every view (GitHub: a request that costs nothing while it is unchanged), " +
      "and the branch is compared again when it moved, when the default branch changed, and hourly (the default branch can move the merge base); `refresh=1` compares again. " +
      'When the code host cannot be asked (503, 429, 502), the cached diff is served with `stale: true` (not with refresh=1). ' +
      "GitHub lists at most 300 files of a comparison in its JSON and reads the rest from the diff text; a comparison whose diff is over 20 MB lists the files GitHub's JSON has. " +
      "Errors: 400 an invalid branch name, or the default branch itself; 404 unknown repo, a branch the code host doesn't have, or one that can't be compared (no history in common with the default branch); " +
      "409 the repo's default branch isn't known yet (sync it); 503 no token for the repo's source, 429 rate limit (details.resetAt), 502 other failures of the code host, 403 for cross-site browser requests.",
    params: [
      REPO, p('branch', 'Branch name, URL-encoded as one segment (`feature%2Fx` for feature/x).'),
      q('refresh', "'1' compares the branch again instead of trusting the cached diff.", enumOf('1')),
    ],
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
  ...commentEndpoints(),
  {
    method: 'get', path: '/api/v1/agents', tag: 'Comments', summary: 'The agents that may comment through MCP (never their tokens)',
    description:
      'Oldest first, revoked ones included. Agents are made, given a new token, limited to some sources and revoked in the desktop app ' +
      "(Settings → Agents) or with the headless server's `agents` command: never over HTTP. An agent connects to POST /mcp with " +
      '`Authorization: Bearer <its token>`.',
    response: { status: 200, schema: obj({ items: arr(ref('Agent')) }) },
  },
  {
    method: 'get', path: '/api/v1/stream', tag: 'Comments', summary: 'What changes, as it happens (server-sent events)',
    description:
      'text/event-stream: one `data: <json>` event per StreamMessage, nothing replayed. `comments`: a thread changed (repo, kind, number, branch, commitOid, ' +
      'threadId, event, by; views of its branch, and of the PRs from it, list it too); `show`: an agent asks the app to show something (id, agent, target ' +
      '{repo, pr?, branch?, commit?, threadId?, path?}, message, at); `agents`: an agent ' +
      'was added, given a new token or revoked. A comment line (`: ping`) every 25 s keeps proxies from closing an idle stream; behind nginx, turn ' +
      'proxy_buffering off for it (deploy/nginx.conf.example). At most 32 streams are open at once (503 with Retry-After beyond), and a client ' +
      'that stops reading is disconnected once 256 KB wait for it: reconnect and refetch.',
    response: { status: 200, schema: str(), type: 'text/event-stream' },
  },
  { method: 'get', path: '/api/v1/sync/status', tag: 'Sync', summary: 'Sync progress, last result, next run and rate limit', response: { status: 200, schema: ref('SyncStatus') } },
  {
    method: 'post', path: '/api/v1/sync', tag: 'Sync', summary: 'Start a sync now (409 if one is running)',
    description:
      'Without `repo` or `source`, every source that has a token, each on its own. ' +
      '`source` (a host, e.g. github.com or gitlab.example.com) syncs that source alone: 404 when it isn\'t a source here, 400 when it isn\'t configured on this server. ' +
      '`repo` (a key, or the short name of a repo you own on github.com; with `source`, its path there) limits the sync to one repo (404 when a key names no tracked repository: add it first); `full` ignores high-water marks, re-fetches the backfill window and re-diffs stars. ' +
      'The tokens are resolved afresh; when none of the sources has one the answer is 503 with the reasons.',
    body: { schema: obj({ repo: str(), full: bool, source: str('A source\'s host') }, ['repo', 'full', 'source']), example: { full: true }, optional: true },
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
              ...(e.textFormats ? { 'text/markdown': { schema: str() } } : {}),
              ...(e.textFormats === true ? { 'text/csv': { schema: str() } } : {}),
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
        'Read-only dashboard of activity across your repositories on GitHub and GitLab (its "sources"). Timestamps are ISO-8601 UTC. ' +
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
