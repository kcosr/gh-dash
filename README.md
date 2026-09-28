# gh-dash

A self-hosted dashboard for activity across your own GitHub repositories. Browse pull
requests and their descriptions, follow commits, issues, releases and stars, and see
trends over time. Filter by repository, date, visibility or contributor.

gh-dash syncs to a local database for fast browsing. It reads from GitHub without
changing your repositories.

![Activity timeline](docs/images/activity.png)

<table>
  <tr>
    <td><a href="docs/images/pull-requests.png"><img src="docs/images/pull-requests.png" alt="Pull requests view with the detail drawer open"></a></td>
    <td><a href="docs/images/repositories.png"><img src="docs/images/repositories.png" alt="Repositories grid"></a></td>
    <td><a href="docs/images/insights.png"><img src="docs/images/insights.png" alt="Insights charts"></a></td>
  </tr>
  <tr>
    <td align="center">Pull requests</td>
    <td align="center">Repositories</td>
    <td align="center">Insights</td>
  </tr>
</table>

## Getting started

You need **Node.js 22.13 or newer** and a GitHub token with read access to your repositories.
For a fine-grained token, select your repositories and grant **Metadata**, **Contents**,
**Pull requests** and **Issues** read access. Set it in the `GITHUB_TOKEN` environment
variable, or sign in with `gh auth login` if you use the GitHub CLI.

From the project directory:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4780**. The first sync starts automatically and fetches the
last year of activity; progress appears in the header. Only repositories owned by
the signed-in user are synced.

## Using the dashboard

- **Pull requests:** read descriptions, filter by state, and open a detail drawer.
- **Diffs:** open a PR's changes with **Files changed** in its drawer, or click a commit's SHA
  in the drawer or Activity (modifier-click still opens GitHub). Diffs are fetched from GitHub
  on demand and cached on the server; see **Settings → Diff cache** for its size limit and to clear it.
- **Issues:** browse open or closed issues, expand descriptions, and filter by creator, repository, or date.
- **Activity:** browse a combined timeline and jump to a day using the activity strip.
- **Repositories and Insights:** explore repository activity, contributors and trends.
- **Keyboard shortcuts:** `Ctrl/Cmd+K` opens search; `/` focuses the filter. In the PR
  list, use `j`/`k` to move, `Enter` to open details, `d` to view the diff, and `Esc` to close.

Use **Settings** to adjust the sync interval, backfill window and fork inclusion.
Add any unlinked commit emails under **My commit emails** so those commits count as yours.
Click a sidebar repository row to focus on it; use its checkbox to add or remove it
from your selection. The selection applies to Pull requests, Issues, Activity,
Repositories, and Insights, and carries across tabs. Expand **Show inactive** to select
archived, hidden, or forked repositories explicitly. Sidebar badges show nonzero open PR and issue counts as of the last sync.
Click repository names in lists and activity to filter to them. Drag the sidebar's
divider to resize it; its width is saved in your browser. You can also focus the
divider and use arrow keys, or double-click it to reset the width. To make more room,
hide the sidebar with the sidebar button at the top left or `[`; your browser remembers
whether it's shown.
On narrow screens, the sidebar starts closed. Use the sidebar button to open it
full screen, then choose a repository or tap Close to return to the list. PR details
and diffs also use the full content area on narrow screens; close them to return to the list.
Mobile filter bars start as a single summary row; tap Filters to expand or collapse the controls.

## Configuration and deployment

Settings come from environment variables, which can also be set in
`$XDG_CONFIG_HOME/gh-dash/env` (default `~/.config/gh-dash/env`) as `KEY=value` lines.
Shell expansion is not performed there; use absolute paths.

They can also live in a JSON file, `$XDG_CONFIG_HOME/gh-dash/config.json` (or the path in
`GH_DASH_CONFIG`). Its keys mirror the variables: `host`, `port`, `allowedHosts`, `db`,
`cacheDb`, `sync`, `password`, `apiKey`, `myEmails`, `timezone` (`TZ`), `tokenSource`,
`tokenFile` and `ghPath`. Lists are arrays and `sync` is a boolean; `null` clears
`password`, `apiKey`, `tokenFile` and `ghPath`:

```json
{ "port": 4780, "db": "/srv/gh-dash/gh-dash.db", "allowedHosts": ["dash.example.com"], "tokenFile": "/etc/gh-dash/github-token" }
```

Precedence, lowest first: defaults, `config.json`, the env file, then process environment
variables. A variable that is set wins even when empty. Unknown keys are logged and ignored;
invalid values stop the server with a message naming the file. `GET /api/v1/instance` shows
each effective setting and where it came from. Restart after edits, and keep files that
contain credentials private (`chmod 600`); gh-dash warns about a readable `config.json`
that holds a password or API key.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Unset | Read-only GitHub access; wins over every other token source |
| `GITHUB_TOKEN_FILE` | Unset | A file holding just the token, re-read on use, so replacing it needs no restart |
| `GH_DASH_TOKEN_SOURCE` | `auto` | Without `GITHUB_TOKEN`: `auto` uses the token file if one is set, else the GitHub CLI; `file` or `gh` use only that |
| `GH_DASH_GH_PATH` | `PATH`, then standard install locations | The GitHub CLI (`gh`) executable |
| `HOST` / `PORT` | `127.0.0.1` / `4780` | Listen address |
| `GH_DASH_ALLOWED_HOSTS` | Unset | Host names the server answers to besides `localhost` and IP addresses, comma-separated |
| `GH_DASH_DB` | `$XDG_STATE_HOME/gh-dash/gh-dash.db` | Database location |
| `GH_DASH_CACHE_DB` | `gh-dash-cache.db` next to the database | Diff cache location |
| `GH_DASH_SYNC` | `on` | Set to `off` to disable automatic syncs |
| `GH_DASH_PASSWORD` | Unset | Require a password to access the dashboard |
| `GH_DASH_API_KEY` | Unset | Key API clients send as Bearer or `X-API-Key`; not access control without a password (see below) |
| `GH_DASH_MY_EMAILS` | Unset | Additional commit emails, comma-separated |
| `TZ` | System timezone | Default timezone for API date grouping |
| `GH_DASH_CONFIG` | `$XDG_CONFIG_HOME/gh-dash/config.json` | JSON config file (see above) |

Without `XDG_STATE_HOME`, the database defaults to `~/.local/state/gh-dash/gh-dash.db`.
Empty or relative XDG paths use the home defaults. UI settings remain in the database.
An existing checkout-local database is not moved automatically; set `GH_DASH_DB` to
its absolute path to keep using it.

Diffs and file contents are fetched from GitHub when you open them and kept in a
separate cache database (named after the main database, e.g. `gh-dash-cache.db`). Its size
is capped by the `diffCacheMb` setting (200 MB by default); least recently viewed entries are
dropped first. The cache can be deleted at any time and left out of backups.

For a persistent installation, adapt the [systemd unit](deploy/gh-dash.service).
For remote access, use HTTPS through a reverse proxy such as the supplied
[nginx example](deploy/nginx.conf.example) and set `GH_DASH_PASSWORD` or proxy authentication.

The server only answers requests addressed to `localhost`, a `*.localhost` name or an IP
address, on any port; any other `Host` gets `421 Misdirected Request`. This blocks DNS
rebinding, where a web page on a domain that resolves to your machine uses your browser to
read and change your data. To reach the server by name, such as a LAN hostname or the public
name a reverse proxy passes on (`proxy_set_header Host $http_host` in nginx), list the name in
`GH_DASH_ALLOWED_HOSTS`, e.g. `GH_DASH_ALLOWED_HOSTS=dash.example.com`.

An API key alone is **not** access control. Without `GH_DASH_PASSWORD`, opening any dashboard
page issues a session cookie that also unlocks the API, so anyone who can reach the server
can read everything. Set a password, or use proxy authentication, whenever others can reach
the server; gh-dash logs a warning at startup when it listens beyond loopback with only an
API key. `/api/health`, `/api/docs` and `/api/v1/openapi.json` never need credentials.

## API and exports

The **API** button shows the current view's URL. Lists can be exported as Markdown
or CSV. Explore the endpoint reference at `/api/docs` and the OpenAPI document at
`/api/v1/openapi.json` on your running instance.

## Development

```sh
npm run dev        # API on :4780, web app on :5173
npm run typecheck
npm test
npm run build
```

## License

[MIT](LICENSE).
