import { ENDPOINTS, type EndpointDoc, type ParamDoc } from './openapi';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function schemaLabel(s: Record<string, unknown>): string {
  const type = Array.isArray(s.type) ? s.type.join(' | ') : String(s.type ?? '');
  const enums = Array.isArray(s.enum) ? s.enum.filter((v) => v !== null).join(' | ') : '';
  return enums || type;
}

function paramRows(params: ParamDoc[]): string {
  return params
    .map((p) => {
      const def = p.schema.default !== undefined ? ` <span class="muted">default ${esc(String(p.schema.default))}</span>` : '';
      return `<tr><td><code>${esc(p.name)}</code>${p.in === 'path' ? ' <span class="muted">path</span>' : ''}</td>
<td><code>${esc(schemaLabel(p.schema))}</code>${def}</td><td>${esc(p.description).replace(/`([^`]+)`/g, '<code>$1</code>')}</td></tr>`;
    })
    .join('');
}

function curl(e: EndpointDoc, origin: string): string {
  const path = e.path
    .replace('{repo}', 'gh-dash')
    .replace('{number}', '1')
    .replace('{name}', 'gh-dash')
    .replace('{id}', '1')
    .replace('{oid}', '0123abc');
  const url = `${origin}${path}${e.example ? `?${e.example}` : ''}`;
  if (e.method === 'get') return `curl -s '${url}'`;
  if (e.method === 'delete') return `curl -s -X DELETE '${url}'`;
  const body = JSON.stringify(e.body?.example ?? {});
  return `curl -s -X ${e.method.toUpperCase()} '${url}' \\\n  -H 'Content-Type: application/json' -d '${body}'`;
}

/** Self-contained HTML reference generated from the endpoint table (no external assets). */
export function docsPage(origin: string, authNote: string | null): string {
  const tags = [...new Set(ENDPOINTS.map((e) => e.tag))];
  const nav = tags.map((t) => `<a href="#${esc(t.replace(/\W+/g, '-'))}">${esc(t)}</a>`).join('');
  const sections = tags
    .map((tag) => {
      const items = ENDPOINTS.filter((e) => e.tag === tag)
        .map(
          (e) => `<section class="ep" id="${esc(`${e.method}-${e.path}`.replace(/\W+/g, '-'))}">
<h3><span class="m ${e.method}">${e.method.toUpperCase()}</span> <code>${esc(e.path)}</code></h3>
<p>${esc(e.summary)}${e.description ? `<br><span class="muted">${esc(e.description)}</span>` : ''}</p>
${e.params?.length ? `<table><thead><tr><th>Param</th><th>Type</th><th>Description</th></tr></thead><tbody>${paramRows(e.params)}</tbody></table>` : ''}
${e.body ? `<p class="muted">JSON body${e.body.optional ? ' (optional)' : ''}: <code>${esc(JSON.stringify(e.body.example))}</code></p>` : ''}
<p class="muted">Response: ${e.response.status}${e.textFormats ? ' · JSON, or <code>format=md</code> / <code>format=csv</code>' : ''}</p>
<pre>${esc(curl(e, origin))}</pre></section>`,
        )
        .join('');
      return `<h2 id="${esc(tag.replace(/\W+/g, '-'))}">${esc(tag)}</h2>${items}`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>gh-dash API</title><style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--get:#1a7f37;--post:#0969da;--patch:#9a6700;--delete:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--code:#151b23;--get:#3fb950;--post:#4493f8;--patch:#d29922;--delete:#f85149}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 20px 80px}h1{margin:0 0 4px}h2{margin:40px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:0 0 6px}nav{display:flex;gap:14px;flex-wrap:wrap;margin:12px 0 0}a{color:var(--post)}
.ep{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0}.muted{color:var(--muted)}
code,pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--code);padding:10px 12px;border-radius:6px;overflow:auto;margin:8px 0 0}
p code,td code{background:var(--code);padding:1px 4px;border-radius:4px}table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{text-align:left;vertical-align:top;padding:5px 8px;border-top:1px solid var(--line)}th{font-weight:600;color:var(--muted)}
.m{display:inline-block;min-width:54px;text-align:center;border-radius:4px;padding:1px 6px;font-size:12px;color:#fff}
.get{background:var(--get)}.post{background:var(--post)}.patch{background:var(--patch)}.delete{background:var(--delete)}
</style></head><body><main>
<h1>gh-dash API</h1>
<p class="muted">Every UI view is available as JSON with the same filters. Timestamps are ISO-8601 UTC. Errors are
<code>{ "error": string }</code>. Machine-readable spec: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>
${authNote ? `<p>${authNote}</p>` : ''}
<nav>${nav}</nav>${sections}
</main></body></html>`;
}
