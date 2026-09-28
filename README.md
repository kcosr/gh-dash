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

Optional config is read from `$XDG_CONFIG_HOME/gh-dash/env` (default
`~/.config/gh-dash/env`), using `KEY=value` lines. Process environment variables
override the file. Restart after edits; keep the file private (`chmod 600`) if it
contains credentials. Shell expansion is not performed; use absolute paths in it.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | GitHub CLI credentials | Read-only GitHub access |
| `HOST` / `PORT` | `127.0.0.1` / `4780` | Listen address |
| `GH_DASH_DB` | `$XDG_STATE_HOME/gh-dash/gh-dash.db` | Database location |
| `GH_DASH_CACHE_DB` | `gh-dash-cache.db` next to the database | Diff cache location |
| `GH_DASH_SYNC` | `on` | Set to `off` to disable automatic syncs |
| `GH_DASH_PASSWORD` | Unset | Require a password to access the dashboard |
| `GH_DASH_API_KEY` | Unset | Authenticate API clients with Bearer or `X-API-Key` |
| `GH_DASH_MY_EMAILS` | Unset | Additional commit emails, comma-separated |
| `TZ` | System timezone | Default timezone for API date grouping |

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
An API key alone does **not** protect access to the dashboard.

## API and exports

The **API** button shows the current view's URL. Lists can be exported as Markdown
or CSV. Explore the endpoint reference at `/api/docs` and the OpenAPI document at
`/api/v1/openapi.json` on your running instance.

## Desktop app

The desktop app runs gh-dash in its own window on macOS, Windows and Linux. It starts the
server in the background and talks to it privately; nothing listens on the network unless you
turn on the **Local API**. Links open in your browser.

```sh
npm ci
npm run desktop        # build, then run the app from the checkout
npm run dist:desktop   # build installers for this OS into release/
```

`npm run dist:desktop` produces an AppImage and a `.deb` on Linux, an NSIS installer on
Windows, and a `.dmg` and `.zip` on macOS. The [Desktop app workflow](.github/workflows/desktop.yml)
builds all three on pull requests. The builds are not signed: macOS asks you to confirm opening
the app, and Windows SmartScreen warns. Signing and notarization are not set up yet.

`npm ci` doesn't download Electron itself: Electron fetches its binary the first time it
runs (`npm run desktop`), or run `npx install-electron` beforehand.

**Where things live.** The app keeps its settings (`config.json`), window size, logs and any
remembered token in its own folder, separate from the headless server's `~/.config/gh-dash`:

| Linux | macOS | Windows |
| --- | --- | --- |
| `~/.config/gh-dash-desktop` | `~/Library/Application Support/gh-dash-desktop` | `%APPDATA%\gh-dash-desktop` |

The database is `data/gh-dash.db` in that folder unless you pick another data folder in
**Settings**. Picking a folder doesn't move an existing database: gh-dash uses the one in
that folder or starts a new one. The app writes `config.json` from Settings; environment
variables still override it. Logs, including the server's, are in `logs/main.log`.

**GitHub account.** In **Settings → GitHub account**, either use the GitHub CLI (`gh auth token`;
run `gh auth login` first) or paste a token. **Remember on this device** stores a pasted token
encrypted with the system keychain (macOS Keychain, Windows DPAPI, or GNOME Keyring/KWallet
on Linux). Without a keychain, as on Linux desktops that have neither, the token is kept only
until you quit. On macOS, an unsigned build may ask for keychain access after each update; if
you deny it, the app forgets the token and asks again. `GITHUB_TOKEN` in the app's environment
overrides both.

**Local API.** Turn it on in **Settings** to reach the API from browsers, curl and scripts
(`/api/docs`). It listens on `127.0.0.1` only, unless you allow other devices on the network,
which requires a password. Add an API key for scripts, and list any host names other than
`localhost` and IP addresses under allowed hosts. If its port is taken when the app starts, the
app offers to turn the Local API off.

**Linux.** When `/dev/shm` is smaller than 512 MB, as in many containers, the app passes
`--disable-dev-shm-usage` to Chromium itself. The AppImage needs FUSE; without it, run it with
`--appimage-extract-and-run`.

Troubleshooting: `GH_DASH_DEBUG=1` enables reload and DevTools in the View menu, and
`GH_DASH_DESKTOP_USER_DATA=/absolute/path` runs the app with a separate settings folder.

## Development

```sh
npm run dev        # API on :4780, web app on :5173
npm run typecheck
npm test
npm run build
```

## License

[MIT](LICENSE).
