import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { AgentAccessInventory, RepoAgentAccess } from '../../../shared/agent-access';
import { useAgentAccessActions } from '../api/desktop';
import { useAgentAccess, useInstance } from '../api/hooks';
import { RepositoryAccessChoice } from '../components/AgentAccess';
import { bridgeError } from '../lib/account';
import { fmtNum, plural } from '../lib/time';
import { Button, ErrorState, FilterInput, useToast } from '../workbench';

function RepositoryAccessEditor({ data, initialHost, initialQuery }: {
  data: AgentAccessInventory;
  initialHost: string;
  initialQuery: string;
}) {
  const [host, setHost] = useState(initialHost);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(() => new Set<number>());
  const { editable, setRepositories } = useAgentAccessActions();
  const toast = useToast();
  const sources = new Map(data.sources.map((source) => [source.host, source]));
  const sourceFilter = sources.has(host) ? host : '';
  const term = query.trim().toLowerCase();
  const matching = data.repos.filter((repo) => (!sourceFilter || repo.source === sourceFilter) &&
    (!term || repo.key.toLowerCase().includes(term) || repo.nameWithOwner.toLowerCase().includes(term)));
  const selectedIds = data.repos.filter((repo) => selected.has(repo.id)).map((repo) => repo.id);
  const visibleSelected = matching.filter((repo) => selected.has(repo.id)).length;
  const hiddenSelected = selectedIds.length - visibleSelected;
  const allSelected = matching.length > 0 && visibleSelected === matching.length;

  const select = (ids: number[], checked: boolean) => setSelected((previous) => {
    const next = new Set(previous);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    return next;
  });

  const update = (ids: number[], access: RepoAgentAccess) => setRepositories.mutate({ ids, access }, {
    onSuccess: () => toast(`Updated access for ${fmtNum(ids.length)} ${plural(ids.length, 'repository', 'repositories')}`),
    onError: (error) => toast(bridgeError(error), { tone: 'error' }),
  });
  const cannotApply = !selectedIds.length || setRepositories.isPending;
  const RepositoryName = editable ? 'label' : 'div';

  return (
    <>
      <div className="agent-access-controls">
        <select className="wb-input wb-input--auto" aria-label="Repository access source" value={sourceFilter}
          onChange={(event) => setHost(event.target.value)}>
          <option value="">All sources</option>
          {data.sources.map((source) => <option key={source.host} value={source.host}>{source.host}</option>)}
        </select>
        <FilterInput value={query} onChange={setQuery} placeholder="Search repositories" hotkey={null} />
      </div>
      {editable && (
        <div className="agent-access-controls agent-access-bulk">
          <Button size="sm" disabled={!matching.length || setRepositories.isPending}
            onClick={() => select(matching.map((repo) => repo.id), !allSelected)}>
            {allSelected ? 'Deselect all matches' : 'Select all matches'}
          </Button>
          <span className="muted" role="status">
            {fmtNum(selectedIds.length)} selected{hiddenSelected > 0 && ` · ${fmtNum(hiddenSelected)} hidden by filters`}
          </span>
          {selectedIds.length > 0 && <Button size="sm" variant="ghost" disabled={setRepositories.isPending}
            onClick={() => setSelected(new Set())}>Clear selection</Button>}
          <span className="spacer" />
          <Button size="sm" disabled={cannotApply} onClick={() => update(selectedIds, 'allow')}>Allow selected</Button>
          <Button size="sm" disabled={cannotApply} onClick={() => update(selectedIds, 'block')}>Block selected</Button>
          <Button size="sm" disabled={cannotApply} aria-label="Use source default for selected" onClick={() => update(selectedIds, 'inherit')}>Use source default</Button>
        </div>
      )}
      {matching.length > 0 ? (
        <ul className="trk-list agent-access-list" aria-label="Tracked repository access" tabIndex={editable ? undefined : 0}>
          {matching.map((repo) => {
            const source = sources.get(repo.source);
            if (!source) return null;
            return (
              <li className="trk-row" key={repo.id}>
                <RepositoryName className="agent-access-repository">
                  {editable && <input className="repo-check" type="checkbox" aria-label={`Select ${repo.key}`}
                    checked={selected.has(repo.id)} disabled={setRepositories.isPending}
                    onChange={(event) => select([repo.id], event.target.checked)} />}
                  <span className="agent-access-name" title={repo.key}>
                    {repo.nameWithOwner}{!sourceFilter && <small className="muted">{repo.source}</small>}
                  </span>
                </RepositoryName>
                <RepositoryAccessChoice repo={repo} defaultAccess={source.defaultAccess} disabled={setRepositories.isPending}
                  onChange={editable ? (access) => update([repo.id], access) : undefined} />
              </li>
            );
          })}
        </ul>
      ) : <p className="agent-access-empty muted">{data.repos.length ? 'No matching repositories.' : 'No tracked repositories yet.'}</p>}
    </>
  );
}

export function RepositoryAccessSection() {
  const inventory = useAgentAccess();
  const { editable } = useAgentAccessActions();
  const desktopServer = useInstance().data?.desktop;
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const host = params.get('accessSource') ?? '';
  const repo = params.get('accessRepo') ?? '';

  return (
    <section className="card set-sec" id="repository-access">
      <h2>Repository access</h2>
      <p>Choose which repositories agents can access through gh-dash. Newly tracked repositories use the <Link to="/settings#sources">source default</Link>.</p>
      {inventory.data ? <RepositoryAccessEditor key={JSON.stringify([host, repo])} data={inventory.data} initialHost={host} initialQuery={repo} />
        : inventory.isError ? <ErrorState error={inventory.error} onRetry={() => void inventory.refetch()} />
          : <p className="muted">Loading…</p>}
      {!editable && <p className="set-foot muted">
        {desktopServer ? 'Change access in the gh-dash desktop app.' : <>Change access with <code>agents repository-access</code> where the server runs.</>}
      </p>}
    </section>
  );
}
