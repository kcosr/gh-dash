/**
 * Dev-only diff gallery (web/diff-gallery.html): the diff viewer on real GitHub diffs, with the
 * shell's inputs (theme, compact, deep-linked file, file loading) as controls. Not part of the app
 * bundle. State lives in the query string so screenshots can link straight to a case:
 * ?f=<fixture>&theme=dark&compact=1&file=<path>&load=none
 */
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../styles/app.css';
import { StrictMode, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Diff } from '../../../shared/api';
import { Diffstat } from '../components/bits';
import { Icon } from '../components/Icon';
import { plural } from '../lib/time';
import DiffViewer, { type DiffComments } from './DiffViewer';

// Small fixtures are committed; the large ones (fixtures/.gitignore) only show up when copied in.
const FIXTURES = import.meta.glob<Diff>('./fixtures/*.json', { import: 'default' });
const fixtureName = (key: string) => key.replace(/^.*\//, '').replace(/\.json$/, '');
const NAMES = Object.keys(FIXTURES).map(fixtureName).sort();

type Params = { f: string; theme: 'light' | 'dark'; compact: boolean; file: string | null; load: 'raw' | 'none' };

// No server here: no threads, and writing one says so.
const noServer = () => Promise.reject(new Error('the gallery has no server'));
const COMMENTS: DiffComments = {
  key: 'gallery', threads: [], error: false, me: undefined, initialThread: null, onThreadFocus: () => {}, only: null, onOnlyChange: () => {},
  actions: { create: noServer, reply: noServer, setStatus: noServer, edit: noServer, deleteComment: noServer, deleteThread: noServer },
};

function readParams(): Params {
  const q = new URLSearchParams(location.search);
  return {
    f: q.get('f') ?? 'gh-dash-pr-2',
    theme: q.get('theme') === 'dark' ? 'dark' : 'light',
    compact: q.get('compact') === '1',
    file: q.get('file'),
    load: q.get('load') === 'none' ? 'none' : 'raw',
  };
}

function writeParams(p: Params) {
  const q = new URLSearchParams();
  q.set('f', p.f);
  if (p.theme === 'dark') q.set('theme', 'dark');
  if (p.compact) q.set('compact', '1');
  if (p.file) q.set('file', p.file);
  if (p.load === 'none') q.set('load', 'none');
  history.replaceState(null, '', `?${q}`);
}

/** Fixtures only carry the repo name; they all come from public repos of this owner. */
const OWNER = 'kcosr';

function Gallery() {
  const [p, setP] = useState(readParams);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [inView, setInView] = useState('');
  const update = (patch: Partial<Params>) => setP((cur) => ({ ...cur, ...patch }));
  // Like the shell: focus starts on the body, and the viewer takes it from there.
  const focusBody = useCallback((el: HTMLDivElement | null) => el?.focus({ preventScroll: true }), []);

  useEffect(() => { writeParams(p); }, [p]);
  useEffect(() => { document.documentElement.dataset.theme = p.theme; }, [p.theme]);
  useEffect(() => {
    let live = true;
    setDiff(null);
    const key = Object.keys(FIXTURES).find((k) => fixtureName(k) === p.f);
    if (key) void FIXTURES[key]().then((d) => { if (live) { performance.mark('diff:set'); setDiff(d); } });
    return () => { live = false; };
  }, [p.f]);
  // How long the viewer takes to mount (parse + first render), without the fixture's own load time.
  useLayoutEffect(() => {
    if (diff) console.info(`diff viewer mounted in ${Math.round(performance.measure('diff:mount', 'diff:set').duration)} ms`);
  }, [diff]);

  const loadFile = useCallback(async (ref: string, path: string) => {
    if (p.load === 'none' || !diff) return null;
    const res = await fetch(`https://raw.githubusercontent.com/${OWNER}/${diff.repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`);
    return res.ok ? res.text() : null;
  }, [diff, p.load]);

  return (
    <div className="gal">
      <div className="gal-bar">
        <label>fixture
          <select value={p.f} onChange={(e) => update({ f: e.target.value, file: null })}>
            {NAMES.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={p.theme === 'dark'} onChange={(e) => update({ theme: e.target.checked ? 'dark' : 'light' })} /> dark</label>
        <label><input type="checkbox" checked={p.compact} onChange={(e) => update({ compact: e.target.checked })} /> compact</label>
        <label><input type="checkbox" checked={p.load === 'none'} onChange={(e) => update({ load: e.target.checked ? 'none' : 'raw' })} /> loadFile → null</label>
        <span className="spacer" />
        <span>in view: <b className="num">{inView || '—'}</b></span>
      </div>
      {diff && (
        <section className="diff-view">
          <header className="dv-head">
            <span className="repo-chip"><Icon name="book" />{diff.repo}</span>
            <span className="num">{diff.number != null ? `#${diff.number}` : diff.headOid.slice(0, 7)}</span>
            <h2 className="dv-title" title={diff.title}>{diff.title}</h2>
            <Diffstat add={diff.additions} del={diff.deletions} />
            <span className="dv-files">{diff.totalFiles.toLocaleString()} {plural(diff.totalFiles, 'file')}</span>
            <span className="dv-actions">
              <a className="btn" href={diff.url} target="_blank" rel="noreferrer"><Icon name="ext" /><span className="dv-lbl">Open on GitHub</span></a>
              <button type="button" className="btn icon ghost" aria-label="Refresh diff"><Icon name="sync" /></button>
              <button type="button" className="btn icon ghost" aria-label="Close diff"><Icon name="x" /></button>
            </span>
          </header>
          <div className="dv-body" tabIndex={-1} ref={focusBody}>
            <DiffViewer
              key={`${p.f}:${p.load}`}
              diff={diff}
              loadFile={loadFile}
              compact={p.compact}
              isActive={() => true}
              file={p.file}
              onFileChange={setInView}
              comments={COMMENTS}
            />
          </div>
        </section>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
