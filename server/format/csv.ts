import type { ActivityEvent, Actor, Commit, Issue, PullRequest, Release, Star } from '../../shared/api';
import { refText } from '../../shared/provider';
import { GITHUB_ONLY, type KindOf } from './markdown';

type Cell = string | number | boolean | null;

function cell(v: Cell): string {
  if (v === null) return '';
  if (typeof v !== 'string') return String(v);
  // Keep spreadsheets from evaluating untrusted text (titles etc.) as formulas.
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a header row and CRLF line endings. */
export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const person = (a: Actor | null) => a?.login ?? a?.name ?? null;

export function prsCsv(prs: PullRequest[]): string {
  return toCsv(
    ['repo', 'number', 'title', 'state', 'draft', 'author', 'created_at', 'merged_at', 'closed_at', 'activity_at',
      'additions', 'deletions', 'changed_files', 'commits', 'labels', 'url'],
    prs.map((p) => [
      p.repo, p.number, p.title, p.state, p.isDraft, person(p.author), p.createdAt, p.mergedAt, p.closedAt, p.activityAt,
      p.additions, p.deletions, p.changedFiles, p.commitCount, p.labels.map((l) => l.name).join(';'), p.url,
    ]),
  );
}

export function commitsCsv(commits: Commit[]): string {
  return toCsv(
    ['repo', 'oid', 'committed_at', 'author_login', 'author_name', 'headline', 'additions', 'deletions', 'pr_number', 'url'],
    commits.map((c) => [
      c.repo, c.oid, c.committedAt, c.author.login, c.author.name, c.headline, c.additions, c.deletions, c.prNumber, c.url,
    ]),
  );
}

export function issuesCsv(issues: Issue[]): string {
  return toCsv(
    ['repo', 'number', 'title', 'state', 'author', 'closed_by', 'created_at', 'closed_at', 'labels', 'url'],
    issues.map((i) => [
      i.repo, i.number, i.title, i.state, person(i.author), person(i.closedBy), i.createdAt, i.closedAt,
      i.labels.map((l) => l.name).join(';'), i.url,
    ]),
  );
}

export function releasesCsv(releases: Release[]): string {
  return toCsv(
    ['repo', 'tag', 'name', 'published_at', 'prerelease', 'author', 'url'],
    releases.map((r) => [r.repo, r.tag, r.name, r.publishedAt, r.isPrerelease, person(r.author), r.url]),
  );
}

export function starsCsv(stars: Star[]): string {
  return toCsv(
    ['repo', 'login', 'name', 'starred_at'],
    stars.map((s) => [s.repo, s.user.login, s.user.name, s.starredAt]),
  );
}

function eventCells(e: ActivityEvent, kindOf: KindOf): [string | null, string | null, string, string] {
  switch (e.type) {
    case 'commit':
      return [null, e.commit.headline, e.commit.shortOid, e.commit.url];
    case 'pr':
      return [e.kind, e.pr.title, refText(kindOf(e.repo), '', e.pr.number, 'pr'), e.pr.url];
    case 'issue':
      return [e.kind, e.issue.title, refText(kindOf(e.repo), '', e.issue.number, 'issue'), e.issue.url];
    case 'release':
      return [null, e.release.name ?? e.release.tag, e.release.tag, e.release.url];
    case 'star':
      return [null, null, '', ''];
    // Comments are gh-dash's own: no url. The title is what was said; the ref is what it's on.
    case 'comment': {
      const { target } = e.comment;
      return [e.kind, e.comment.excerpt, target.kind === 'pr' ? refText(kindOf(e.repo), '', target.number, 'pr') : target.oid.slice(0, 7), ''];
    }
  }
}

/** `kindOf`: each repo's host, for the `ref` column (`#12`, or `!12` for a GitLab MR). */
export function activityCsv(events: ActivityEvent[], kindOf: KindOf = GITHUB_ONLY): string {
  return toCsv(
    ['at', 'type', 'kind', 'repo', 'actor', 'title', 'ref', 'url'],
    events.map((e) => {
      const [kind, title, ref, url] = eventCells(e, kindOf);
      return [e.at, e.type, kind, e.repo, person(e.actor), title, ref, url];
    }),
  );
}
