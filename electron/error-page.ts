/**
 * The page shown when the server child can't start (bad config.json, database locked, Local API port in use...).
 * Main serves it itself; its buttons are app:// links to /__gh-dash/* actions that main handles (no scripts).
 */
export const ACTION_PREFIX = '/__gh-dash/';
export type ErrorPageAction = 'retry' | 'disable-local-api' | 'show-config' | 'quit';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function errorPageHtml(opts: { message: string; configPath: string; localApiOn: boolean }): string {
  const link = (action: ErrorPageAction, label: string, primary = false) =>
    `<a class="btn${primary ? ' primary' : ''}" href="${ACTION_PREFIX}${action}">${label}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>gh-dash</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f3; --text: #1f2328; --muted: #656d76; --border: #d8dadd; --accent: #2a78d6; --surface: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0d0d; --text: #e6e6e6; --muted: #9a9a9a; --border: #2c2c2c; --accent: #3987e5; --surface: #161616; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 13.5px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 14vh auto; padding: 22px 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
h1 { font-size: 15px; margin: 0 0 8px; }
p { margin: 8px 0; color: var(--muted); }
pre { white-space: pre-wrap; word-break: break-word; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; margin: 12px 0; color: var(--text); }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.btn { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); text-decoration: none; font-weight: 500; }
.btn:hover { border-color: var(--muted); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style></head>
<body><main>
<h1>gh-dash couldn't start its server</h1>
<pre>${escape(opts.message)}</pre>
<p>Settings are in <code>${escape(opts.configPath)}</code>.${opts.localApiOn ? ' If the Local API port is taken, turn the Local API off and start again.' : ''}</p>
<div class="row">${link('retry', 'Try again', true)}${opts.localApiOn ? link('disable-local-api', 'Turn off the Local API') : ''}${link('show-config', 'Show config file')}${link('quit', 'Quit')}</div>
</main></body></html>`;
}
