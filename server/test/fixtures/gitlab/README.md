# GitLab fixtures

Hand-built, **not recorded**: no GitLab instance was reachable when they were written. Their shapes follow GitLab
19.3.3's GraphQL types and REST entities as read from GitLab's source at tag `v19.3.3` (the `gitlabhq/gitlabhq`
mirror, which has no `ee/` directory). The values are made up; the tests pin the mapping, not GitLab's data.

Timestamps follow what GitLab sends: GraphQL `Time` in UTC with `Z`, REST with milliseconds, and REST commit dates in
the committer's own UTC offset. Uploaded avatars are paths on the instance in GraphQL (`avatarUrl`) and absolute URLs
in REST (`avatar_url`).

| File | Response of |
| --- | --- |
| `viewer.json` | GraphQL `Viewer` (`currentUser`) |
| `viewer-account.json` | GraphQL `ViewerAccount` (`currentUser` with `publicEmail`, `commitEmail`, `emails`) |
| `owned-projects.json` | GraphQL `OwnedProjects` (`currentUser` and `projects(personal: true)`) |
| `project.json` | GraphQL `Project` (`currentUser` and `project(fullPath:)` with probe fields) |
| `lookup.json` | GraphQL `ProjectLookup` (that project plus `userPermissions`, `issuesEnabled` and the counts) |
| `member-projects.json` | REST `GET /projects?membership=true` (the full entity, newest activity first; the fake instance also serves it as `simple=true`, without visibility, archived and the fork's upstream) |
| `probes.json` | GraphQL `Probes` (`projects(ids:)`) |
| `merge-requests.json` | GraphQL `MergeRequests` (`project.mergeRequests`) |
| `releases.json` | GraphQL `Releases` (`project.releases`) |
| `issues.json` | REST `GET /projects/:id/issues?with_labels_details=true` |
| `commits.json` | REST `GET /projects/:id/repository/commits?with_stats=true` |
| `starrers.json` | REST `GET /projects/:id/starrers` |
| `mr-revision.json` | GraphQL `MrRevision` (`project.mergeRequest(iid:)`) |
| `mr-versions.json` | REST `GET /projects/:id/merge_requests/:iid/versions` |
| `mr-version.json` | REST `GET /projects/:id/merge_requests/:iid/versions/:version_id` (without `unidiff`) |
| `commit.json` | REST `GET /projects/:id/repository/commits/:sha` |
| `commit-diff.json` | REST `GET /projects/:id/repository/commits/:sha/diff` |

## Re-record against a real instance

When one is available, capture the same queries (queries.ts) and endpoints with a `read_api` token, scrub names and
URLs, and compare. Worth checking in particular:

- `merge-requests.json`: `workItemRelations` (null unless the `explicit_mr_work_item_relations` flag is on), the order
  of `commits` (expected newest first), `mergeUser` on an open MR with auto-merge set, `closedAt` on a merged MR, and
  that `diffStatsSummary` is present for merged MRs whose source branch is gone.
- `viewer-account.json` / `lookup.json`: the field names the Add dialog and "me" depend on (`emails { nodes { email } }`,
  `commitEmail`, `userPermissions { downloadCode readMergeRequest }`, `issuesEnabled`, `updatedAfter` on
  `mergeRequests` / `issues`, `count` on `releases`), and what a Guest gets for them on a private project.
- `merge-requests.json`: `mergeCommitSha` / `squashCommitSha` on merged MRs of each merge method (merge commit, squash,
  fast-forward), and that they are null on open and closed ones.
- `member-projects.json`: that `simple=true` really leaves out `visibility` (the sync source lists the full entity for
  that reason), `forked_from_project` on a fork whose upstream the token can't see, and `namespace.kind` for a project
  shared from another user's personal namespace.
- `owned-projects.json` / `project.json`: `repository.tree.lastCommit` for a non-empty and an empty repository,
  `languages` right after a push (empty until GitLab detects them), relative `avatarUrl`s under a relative root.
- `probes.json`: `count` on the open merge request and issue connections, and `projects(ids:)` with archived projects.
- `issues.json`: label objects with `with_labels_details=true` (3-digit colors?), `closed_by` on issues closed by an MR.
- `commits.json`: the `stats` of merge commits, and the empty last page GitLab offers after a full one.
- `starrers.json`: that the list is oldest first and leaves out private profiles, against `starCount`.
- `mr-version.json`: what `diff` holds for a binary file (a "Binary files … differ" line, or nothing), a pure rename
  and a mode change; `collapsed` / `too_large` files; and that `diffs` lists every stored file of a large MR.
- `mr-versions.json`: that a push to the target branch adds a version with the same head, and that the MR's
  `diffRefs` always match its newest version.
- `mr-revision.json`: `diffStatsSummary` against the files' own +/- counts, and `diffRefs.baseSha` for unrelated
  histories.
- `commit.json`: an abbreviated SHA in the path, and the stats of a merge commit.
