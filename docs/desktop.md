# Desktop app

The desktop app runs gh-dash in its own window on macOS, Windows and Linux. The app starts the
gh-dash server in the background and talks to it over a private channel, so nothing listens on
the network unless you turn on the [Local API](#local-api). Links open in your browser.

## Installing

Build it from a checkout (Node.js 22.13 or newer):

```sh
npm ci
npm run desktop        # build, then run the app from the checkout
npm run dist:desktop   # build an installer for this computer into release/
```

| Platform | `dist:desktop` builds |
| --- | --- |
| macOS | a `.dmg` and a `.zip`, for Apple silicon and Intel |
| Windows | an installer |
| Linux | an AppImage and a `.deb` |

To build only an Apple silicon `.dmg`, which is quicker:

```sh
npm run build && npx electron-builder --mac dmg --arm64 --publish never
```

`npm ci` doesn't download Electron itself: it fetches its binary the first time the app runs, or
run `npx install-electron` beforehand. The [desktop workflow](../.github/workflows/desktop.yml)
builds all three platforms on pull requests.

The builds aren't signed with a developer certificate yet. macOS builds get an ad-hoc signature,
which Apple silicon requires.
- **macOS:** a downloaded build is blocked the first time. Open it once, then allow it under
  **System Settings → Privacy & Security → Open Anyway**.
- **Windows:** SmartScreen warns as well.

## Connecting your accounts

Everything is in **Settings → Sources**.

### GitHub

Use the GitHub CLI (run `gh auth login` first), or paste a token.

- **Finding `gh`.** Apps opened from Finder, the Dock or a launcher don't get your shell's `PATH`.
  At startup the app asks your login shell for it (macOS and Linux) and looks in the usual
  install folders. If `gh` still isn't found, use **Locate gh…**.
- **Remember on this device** keeps a pasted token encrypted with the system keychain: macOS
  Keychain, Windows DPAPI, or GNOME Keyring / KWallet on Linux.
  - Without a keychain, the token is kept only until you quit.
  - On macOS, an unsigned build may ask for keychain access after an update. If you deny it, the
    app forgets the token and asks again.
- **`GITHUB_TOKEN`** in the app's environment overrides both.

### GitLab

**Add GitLab** takes the instance's address, including its path if GitLab is served under one.
Then choose how to sign in:

- **Paste a token.** Kept as for GitHub, in `tokens/<host>.enc`. **Create a read-only token** opens
  GitLab's token page with the name `gh-dash` and only the `read_api` scope filled in.
- **glab:** the token the GitLab CLI holds for that host (`glab auth login --hostname <host>`).
  Use **Locate glab…** if the app can't find it.
- **Token file:** a file you pick, holding just the token.
- **`GITLAB_TOKEN`:** from the app's environment. The app asks before sending it to an address,
  and never uses it for a source by default.

**Test connection** shows the account, the GitLab version, the token's scopes and expiry, and warns
about scopes that can change things. A source is added only after a successful test, and its
first sync starts right away. Later you can check a source again, switch it to another token
(tested first), or remove it together with its data.

The app writes its sources to its `config.json`. Tokens never go there, nor into the database.

## Local API

The Local API is a port on this computer, 4780 unless you change it. It's off until you turn it on
in **Settings → Instance**. It has two switches, each with its own access rules.

| Switch | What it serves | Access |
| --- | --- | --- |
| **REST API** | The JSON API for scripts and curl (`/api/docs`), and the dashboard in a browser | Listens on `127.0.0.1` only, unless you allow other devices, which requires a password. **Without a password, any program on this computer can use it.** An API key is for scripts; it doesn't lock the dashboard. |
| **MCP for agents** | `/mcp`, for coding agents (see [Agents](agents.md)) | **Require agent tokens** is on by default: each agent sends its own. Turned off, a request without a token writes as the built-in **Agent**. A request that does send a token still needs a valid one. |

- **REST API off:** the port serves agents alone, on `127.0.0.1`, and answers everything else with
  "not found". This is the setting to use when you only want agents to connect.
- **MCP off:** `/mcp` answers "not found".
- **Other devices:** tokens are always required once other devices can connect.
- **Enabled for you:** adding an agent while MCP is off turns it on. If the port was off too, it
  comes on for agents only.
- **Before these switches existed:** a Local API that was on keeps serving both, with tokens
  required.
- **Port taken:** if the port is in use when the app starts, the app offers to turn the Local API
  off.

## Where things live

The app keeps its settings (`config.json`), window size, logs and any remembered tokens in its own
folder, separate from a headless server's `~/.config/gh-dash`:

| Linux | macOS | Windows |
| --- | --- | --- |
| `~/.config/gh-dash-desktop` | `~/Library/Application Support/gh-dash-desktop` | `%APPDATA%\gh-dash-desktop` |

- **The database** is `data/gh-dash.db` in that folder, next to the diff cache
  (`data/gh-dash-cache.db`). You can pick another data folder in **Settings**. Picking a folder
  doesn't move an existing database: gh-dash uses the one in that folder, or starts a new one.
- **Logs**, including the server's, are in `logs/main.log`.
- **Agent tokens** the app keeps to show again ([Agents](agents.md#seeing-a-token-again)) are in
  `agent-tokens/<id>.enc`, encrypted with the system keychain, like remembered tokens.
- **Environment variables.** Unlike the headless server, the app ignores `HOST`, `PORT`,
  `GH_DASH_*` and the other configuration variables from its environment, so Settings always
  shows what's in effect. `GITHUB_TOKEN` still applies.

**Before upgrading,** quit the app and copy the `data` folder if you might want to go back. Some
versions upgrade the database, and older versions can't open it afterwards.

## Linux notes

- When `/dev/shm` is smaller than 512 MB, as in many containers, the app passes
  `--disable-dev-shm-usage` to Chromium itself.
- The AppImage needs FUSE. Without it, run it with `--appimage-extract-and-run`.

## Troubleshooting

- `GH_DASH_DEBUG=1` enables reload and DevTools in the View menu.
- `GH_DASH_DESKTOP_USER_DATA=/absolute/path` runs the app with a separate settings and data
  folder. This is useful for trying a new version without touching your everyday data.
