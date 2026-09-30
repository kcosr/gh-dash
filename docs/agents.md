# Agents

Coding agents such as Claude Code and Codex can take part in your reviews in gh-dash through
[MCP](https://modelcontextprotocol.io).

[![A split diff with a comment thread: your question, and an agent's answer marked "agent"](images/review-with-agent.png)](images/review-with-agent.png)

- **Reviewing their own work with you.** You leave comments and questions in a diff. The agent
  answers them, fixes the code, and waits for your reply.
- **Reviewing code they didn't write.** An agent reads the existing threads, adds comments for
  anything not yet raised, and you carry on from there.

Everything stays in gh-dash. Agents, like the rest of gh-dash, never change anything on GitHub or
GitLab.

Each agent has a name and its own token. What it writes, resolves or reopens is shown as its own:
a small **agent** mark in the diff and the Comments tab, and in Activity (**Comments**). You can
filter the Comments tab by author, or to threads **waiting on you**.

Each agent reaches every source, or only the ones you choose: a work GitLab kept apart from a
personal GitHub, say. See [Choosing an agent's sources](#choosing-an-agents-sources).

## Setting up

### 1. Make sure agents can connect

The address is **`http://127.0.0.1:4780/mcp`**, using the Local API's port.

- **Desktop app:** MCP is served on the [Local API](desktop.md#local-api) port. Adding an agent
  turns it on for you if needed, and if the port was off it comes on for agents only.
- **Server:** it's the server's own address followed by `/mcp`.

A token works until you regenerate or revoke it, so an agent's setup never needs changing after a
restart.

### 2. Add an agent

**Desktop app:** go to **Settings → Agents → Add agent** and give it a name, such as "Claude".
- The token field is pre-filled with a generated token; **Generate** makes a new one. You can
  also use a token of your own: 24–256 characters, no spaces, not used by another agent.
- **Sources** is **All** by default. Pick **Only** and check the sources the agent may reach to
  limit it.
- The token is shown **once**, together with setup lines ready to paste.
- The button that says what an agent reaches (**All sources**, **GitHub only**…) changes that.
  **New token…** replaces an agent's token. **Revoke…** removes the agent's access, but its comments
  stay attributed to it.

**Server:** use the `agents` command. It opens the same database as the server (`GH_DASH_DB`,
`config.json`), whether or not the server is running.

```sh
node dist/server/index.mjs agents add Claude          # prints the token, once
node dist/server/index.mjs agents add Work --source gitlab.example.com   # this source only
node dist/server/index.mjs agents list                # with the sources each reaches
node dist/server/index.mjs agents regenerate Claude
node dist/server/index.mjs agents scope Claude --source github.com       # or --all
node dist/server/index.mjs agents revoke Claude       # its comments stay
printf '%s\n' "$MY_TOKEN" | node dist/server/index.mjs agents add Codex --token-stdin   # a token of your own
```

A token of your own is read from standard input, never from the command line, where other programs
could see it.

### 3. Register gh-dash with the agent

**Claude Code** (`-s user` makes it available in every project):

```sh
claude mcp add -s user --transport http gh-dash http://127.0.0.1:4780/mcp --header "Authorization: Bearer <token>"
```

To keep the token out of Claude Code's settings, put it in an environment variable instead. Keep
the single quotes, so Claude Code expands the variable itself when it connects:

```sh
claude mcp add -s user --transport http gh-dash http://127.0.0.1:4780/mcp --header 'Authorization: Bearer ${GH_DASH_AGENT_TOKEN}'
```

`claude mcp list` should then show `gh-dash … ✔ Connected`.

**Codex:**

```sh
codex mcp add gh-dash --url http://127.0.0.1:4780/mcp --bearer-token-env-var GH_DASH_AGENT_TOKEN
export GH_DASH_AGENT_TOKEN=<token>     # in the shell (or profile) Codex starts from
```

This adds the following to `~/.codex/config.toml`:

```toml
[mcp_servers.gh-dash]
url = "http://127.0.0.1:4780/mcp"
bearer_token_env_var = "GH_DASH_AGENT_TOKEN"
```

Give each agent its own gh-dash agent and token, so you can tell their comments apart.

### Choosing an agent's sources

An agent reaches every source by default, including sources you add later. You can instead limit
it to some of them, such as `github.com` or `gitlab.example.com`:

- **Desktop app:** in **Settings → Agents**, use the button that says what the agent reaches
  (**All sources**, or **GitHub only**, say), or **Sources** when you add an agent. The built-in
  **Agent** (see *Running without tokens* below) can be limited the same way, even before it's used.
- **Server:** `agents add <name> --source <host>` or `agents scope <name> --source <host>`. Repeat
  `--source` for more sources, or use `--all` for every source. The hosts are those listed in
  Settings → Sources (or `GET /api/v1/sources`), in any case. An unknown host is refused, and the
  error lists the known ones.

A change applies from the agent's next request. Sources are changed only here, never over HTTP,
just like tokens.

To a limited agent, everything outside its sources doesn't exist:
- a repository there reads as one gh-dash doesn't track, with the same message;
- a thread or comment there reads as one that doesn't exist;
- a source there reads as a host that isn't a source.

Lists (`list_repos`, `list_prs`, `list_threads`) leave the other sources out. `wait_for_reply`
never returns their events or wakes for them. `whoami` lists only the agent's sources and says
it's limited.

Removing a source never gives an agent more: a source added again later, even with the same host,
isn't one it had. An agent left with no sources reaches nothing until you choose again.

Limiting hides what is on the other sources, not that there is activity. Threads, comments and
comment events are numbered in one sequence across all sources. So a limited agent comparing the ids
it sees could tell that *something* happened elsewhere, and roughly how much, but never what, where or
by whom.

**The REST API isn't limited.** The Local API and a server's API (with their password or API key)
are yours, so they reach everything. Only MCP is limited per agent.

## Using it

A few prompts to start from:

> Check gh-dash for my comments on this branch's PR, answer them or fix the code, and wait for my
> replies.

> Review PR #17 in gh-dash. Read the existing threads first, then add comments for anything that
> hasn't been raised.

> Push this branch and review it in gh-dash, before I open a PR: comment where you'd change something.

> Show me in gh-dash where you made that change.

Agents work from their own clone of the repository and their own `gh` or `glab`. gh-dash tells
them which pull request and exact commits a comment belongs to, and where it sits in the latest
code.

### Reviewing a branch before it has a pull request

A pushed branch can be reviewed on its own, against the repository's default branch, and its
comments carry over to the pull requests later opened from it. An agent does this in a few steps:

1. **Push the branch.** gh-dash sees only what GitHub or GitLab has, so a local-only branch has to
   be pushed first.
2. **`get_branch`** with the repository and branch name. It gives the head commit, the merge base,
   the changed files, the pull request from the branch if there is one, and the comment counts.
   (`find_pr` with the current branch says so when there is no pull request, and points to it.)
3. **`add_comment`** with `branch` instead of `pr`, to comment on the whole branch, a file of its
   diff, or lines. `list_threads` with `branch` reads them, and `wait_for_reply` with `branch` waits
   for your answers.

A branch's threads are shared with its pull requests: listing or waiting on a pull request also
covers the threads made on its branch and on its branch's other pull requests, until a merge ends
that line of work. `list_branches` lists what a repository has pushed, newest first, with each
branch's pull request.

## Things to know

- **The repository must be tracked in gh-dash.** If it isn't, the agent is told so. Add it with
  **+ Add repository**.
- **Comments are pinned to pushed commits.** A comment's lines belong to a commit GitHub or GitLab
  knows, normally the pull request's or branch's latest. An agent with unpushed work is asked to
  push first.
- **What agents may do.** Agents can resolve and reopen any thread, and edit or delete only their
  own comments. They can delete a thread only if every comment in it is theirs.
- **`show` requests.** When an agent asks to show you something, a small note appears in your
  window with **Open** and **Dismiss**. Turn on **Follow agents** there to open these automatically,
  except while you're typing.
- **Running without tokens (desktop app).** Turn off **Require agent tokens** in Settings →
  Instance, and a request without a token writes as the built-in **Agent**. This is only allowed
  while the port serves this computer alone. Settings → Agents lists **Agent** then, so you can
  choose its sources too.
- **Behind a reverse proxy**, see the [nginx example](../deploy/nginx.conf.example) for `/mcp` and
  the live updates at `/api/v1/stream`.

## Tools

The tools' own descriptions tell the agent the details.

| Tool | What it does |
| --- | --- |
| `whoami` | The agent's name in gh-dash, the version and the code hosts it may reach |
| `list_repos`, `resolve_repo` | Tracked repositories; the repository key for a git remote URL |
| `list_prs`, `find_pr`, `get_pr` | Pull requests by state or text; by branch or commit; one in full, with its exact commits, fetch refspec and files |
| `list_branches`, `get_branch` | A repository's pushed branches, newest first, with their pull requests; one in full, with its head, merge base, fetch name, files, pull request and comment counts |
| `list_threads`, `get_thread` | Comment threads by repository, pull request, branch, commit, file, status, author or who they wait on, each with where it sits in the latest code |
| `add_comment` | A new thread on a pull request, a pushed branch or a commit: on lines, a file, or the whole change |
| `reply`, `edit_comment`, `delete_comment` | Answer a thread; change or delete the agent's own comments |
| `resolve_thread`, `reopen_thread` | Optionally with a reply first |
| `wait_for_reply` | Waits (45 seconds by default, up to 5 minutes) for someone else to write on the threads it's following: everywhere, or in a repository, pull request, branch or commit |
| `show` | Asks your open gh-dash windows to show a thread, or a pull request's, branch's or commit's diff |
