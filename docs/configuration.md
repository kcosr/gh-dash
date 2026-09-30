# Running the server

gh-dash can run as a small server that you open in a browser, on your own computer or on a machine
you reach over the network. This page covers its settings, GitLab sources, deployment and the API.
For the desktop app, see [Desktop app](desktop.md).

```sh
npm ci
npm run build
npm start          # http://127.0.0.1:4780
```

## Settings

Settings come from four places. Later ones win:

1. the defaults;
2. a JSON file, `$XDG_CONFIG_HOME/gh-dash/config.json` (or the path in `GH_DASH_CONFIG`);
3. an env file, `$XDG_CONFIG_HOME/gh-dash/env`, of `KEY=value` lines (no shell expansion, so use
   absolute paths);
4. the process environment.

A variable that is set wins even when it's empty. `$XDG_CONFIG_HOME` defaults to `~/.config`.

Unknown keys are logged and ignored. An invalid value stops the server with a message naming the
file. `GET /api/v1/instance` shows each effective setting and where it came from. Restart after
changing anything.

**Keep files that hold credentials private** (`chmod 600`). gh-dash warns about a readable
`config.json` that holds a password or API key.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Unset | Read-only GitHub access. Wins over every other token source. |
| `GITHUB_TOKEN_FILE` | Unset | A file holding just the GitHub token. It's re-read on use, so replacing it needs no restart. |
| `GH_DASH_TOKEN_SOURCE` | `auto` | Without `GITHUB_TOKEN`: `auto` uses the token file if one is set, else the GitHub CLI. `file` or `gh` use only that. |
| `GH_DASH_GH_PATH` | `PATH`, then the usual install folders | The GitHub CLI (`gh`) executable. |
| `GH_DASH_GITLAB_URL` | Unset | Declares a GitLab source by its URL, or replaces the `config.json` entry for the same host ([GitLab sources](#gitlab-sources)). |
| `GITLAB_TOKEN` | Unset | Read-only access for the GitLab source. Wins over its other token sources. |
| `GITLAB_TOKEN_FILE` | Unset | A file holding just the GitLab token, re-read on use. |
| `GH_DASH_GITLAB_TOKEN_SOURCE` | The token file if set, else none | `glab` or `file`: where the GitLab source's token comes from when `GITLAB_TOKEN` is unset. |
| `GH_DASH_GLAB_PATH` | `PATH`, then the usual install folders | The GitLab CLI (`glab`) executable. |
| `HOST` / `PORT` | `127.0.0.1` / `4780` | Where the server listens. |
| `GH_DASH_ALLOWED_HOSTS` | Unset | Host names the server answers to besides `localhost` and IP addresses, comma-separated ([Security](#security)). |
| `GH_DASH_DB` | `$XDG_STATE_HOME/gh-dash/gh-dash.db` | The database. Without `XDG_STATE_HOME`: `~/.local/state/gh-dash/gh-dash.db`. |
| `GH_DASH_CACHE_DB` | `gh-dash-cache.db` next to the database | The diff cache. |
| `GH_DASH_SYNC` | `on` | `off` turns automatic syncs off. |
| `GH_DASH_PASSWORD` | Unset | Requires a password to use the dashboard and API. |
| `GH_DASH_API_KEY` | Unset | A key for API clients (`Authorization: Bearer` or `X-API-Key`). On its own, it isn't access control ([Security](#security)). |
| `GH_DASH_MY_EMAILS` | Unset | Other commit emails that count as yours, comma-separated. |
| `TZ` | The system's time zone | The default time zone for grouping dates in the API. |
| `GH_DASH_CONFIG` | `$XDG_CONFIG_HOME/gh-dash/config.json` | The JSON config file. |

Empty or relative XDG paths fall back to the home defaults. Settings you change in the dashboard,
such as the sync interval, are kept in the database.

### config.json

Its keys mirror the variables:
- `host`, `port`, `allowedHosts`, `db`, `cacheDb`, `sync`;
- `password`, `apiKey`, `myEmails`, `timezone` (`TZ`);
- `tokenSource`, `tokenFile`, `ghPath`, `glabPath`;
- `sources`, for [GitLab sources](#gitlab-sources).

Lists are arrays and `sync` is a boolean. `null` clears `password`, `apiKey`, `tokenFile`, `ghPath`
and `glabPath`.

```json
{
  "port": 4780,
  "db": "/srv/gh-dash/gh-dash.db",
  "allowedHosts": ["dash.example.com"],
  "tokenFile": "/etc/gh-dash/github-token"
}
```

## GitLab sources

gh-dash follows repositories on several code hosts, called **sources**: github.com, which is always
there, and any number of GitLab instances, self-managed or gitlab.com. Each source has its own token,
account and sync. Merge requests are listed with the pull requests.

- **Your own projects**, in your personal namespace, are followed automatically. Add others by hand.
- **Repository keys.** A GitLab repository is known by `<host>/<group>/<project>`, for example
  `gitlab.example.com/platform/team/app`. GitHub repositories stay `owner/name`.

Declare a GitLab source in `config.json`:

```json
{
  "glabPath": "/opt/homebrew/bin/glab",
  "sources": [
    { "kind": "gitlab", "url": "https://gitlab.example.com", "tokenSource": "file", "tokenFile": "/etc/gh-dash/gitlab-token" }
  ]
}
```

- `url` is the instance's address, including its path if GitLab is served under one. Its host name
  identifies the source.
- `tokenFile` is an absolute path.
- `tokenEnv` names the environment variable that holds the token. It defaults to `GITLAB_TOKEN`
  when there's only one GitLab source.

A server with a single GitLab source can declare it with `GH_DASH_GITLAB_URL` instead, and choose
its token with `GITLAB_TOKEN`, `GITLAB_TOKEN_FILE` or `GH_DASH_GITLAB_TOKEN_SOURCE`.

**Where a source's token comes from:**

- **The environment:** `GITLAB_TOKEN`, or the source's own `tokenEnv`, is the token whenever it's
  set, and nothing else is used.
- **`file`:** the token file, re-read on use, so replacing it needs no restart. gh-dash warns if
  other users can read it.
- **`glab`:** the token the GitLab CLI holds for that host (`glab auth login --hostname
  gitlab.example.com`). Set `glabPath` if `glab` isn't on `PATH` or in the usual install folders.
  gh-dash stores nothing.
- **No `tokenSource`:** the token file if one is set, otherwise no token.

gh-dash never falls back from one method to another, and a method that fails says why.

- **Token scope.** A token with the `read_api` scope is enough. gh-dash warns when a token can also
  change things (the `api` scope, which glab's token normally has) and when it expires within two
  weeks.
- **Settings → Sources** shows each source's account, token, scopes and expiry, with a link to
  create a read-only token. It also shows the source's projects and last sync. On a server it's
  read-only: you can check a token again, sync a source, or remove one that's no longer configured.

## Database and upgrades

- **Upgrades.** Some versions upgrade the database the first time they start, and **the upgrade
  can't be undone**. An older gh-dash refuses an upgraded database ("upgraded by a newer gh-dash")
  rather than misreading it. Copy the database file first if you might go back.
- **Sync off.** A server running with `GH_DASH_SYNC=off` won't upgrade the database. Start it once
  with syncing on.
- **Checkout-local databases.** An older database inside the checkout isn't moved automatically.
  Set `GH_DASH_DB` to its absolute path to keep using it.
- **The diff cache** is a separate database named after the main one (e.g. `gh-dash-cache.db`).
  - It holds diffs and file contents fetched from GitHub or GitLab when you open them.
  - Its size is capped by the diff cache setting (200 MB by default), and the least recently viewed
    entries go first.
  - It can be deleted at any time and left out of backups.

## Deploying

- **Running as a service:** adapt the [systemd unit](../deploy/gh-dash.service).
- **Remote access:** use HTTPS through a reverse proxy, such as the
  [nginx example](../deploy/nginx.conf.example), and set `GH_DASH_PASSWORD` or use the proxy's
  authentication.
- **What the proxy must allow:**
  - **Encoded slashes** (`%2F`) in paths must pass through unchanged, because API paths carry
    repository keys that way. nginx does this when `proxy_pass` has no URI part, as in the example.
    Apache needs `AllowEncodedSlashes NoDecode`.
  - **Long-lived requests:** the live updates at `/api/v1/stream` and the agents' `/mcp` stay open.
    The nginx example turns off buffering for them.

## Security

- **Host names.** The server only answers requests addressed to `localhost`, a `*.localhost` name or
  an IP address. Any other `Host` gets `421 Misdirected Request`. This blocks DNS rebinding, where a
  web page on a domain that resolves to your machine uses your browser to read or change your data.
  To reach the server by name, such as a LAN host name or the public name a reverse proxy passes on
  (`proxy_set_header Host $http_host` in nginx), list it in `GH_DASH_ALLOWED_HOSTS`.
- **Other sites** can't make changes through your browser: requests that change things are refused
  when they come from another site.
- **An API key alone is not access control.** Without `GH_DASH_PASSWORD`, opening any dashboard page
  issues a session cookie that also unlocks the API. Anyone who can reach the server can then read
  everything. Set a password, or use your proxy's authentication, whenever others can reach the
  server. gh-dash warns at startup when it listens beyond this computer with only an API key.
- **Always open:** `/api/health`, `/api/docs` and `/api/v1/openapi.json` never need credentials.
- **Agents** at `/mcp` always need an agent token on a server ([Agents](agents.md)).
- **Tokens** are never stored in the database and never written over HTTP. Sources and their
  credentials are set only in `config.json`, the environment or the desktop app.

## API

- **Reference.** A running gh-dash documents its API at `/api/docs`, and the OpenAPI document is at
  `/api/v1/openapi.json`. The **API** button in each view shows that view's URL. Lists can also be
  fetched as Markdown or CSV.
- **Repository keys.** A repository is identified by its key: `owner/name` on github.com,
  `<host>/<path>` on other sources.
  - Every `repo` field and id carries it, e.g. `kcosr/gh-dash#24`, or
    `gitlab.example.com/platform/app#7` for a merge request.
  - Path parameters take it URL-encoded as one segment: `/api/v1/repos/kcosr%2Fgh-dash`.
  - Inputs also accept the short name of a github.com repository you own.
- **Sources.** `GET /api/v1/sources` lists the sources with their account, sync state and repository
  counts, and never contains a token. `POST /api/v1/sources/<host>/check` validates a source's token
  again. `DELETE /api/v1/sources/<host>` removes a source that's no longer configured, with all its
  data; nothing changes on GitLab.
