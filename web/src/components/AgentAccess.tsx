import { Link } from 'react-router';
import type { AgentAccessInventory, RepoAgentAccess, SourceAgentAccess } from '../../../shared/agent-access';
import { useAgentAccessActions } from '../api/desktop';
import { useAgentAccess } from '../api/hooks';
import { bridgeError } from '../lib/account';
import { useToast } from '../workbench';

export const ACCESS_STATE = { allow: 'Allowed', block: 'Blocked' } as const;

export function repositoryAccessUrl(host?: string, repo?: string): string {
  const params = new URLSearchParams();
  if (host) params.set('accessSource', host);
  if (repo) params.set('accessRepo', repo);
  return `/settings${params.size ? `?${params}` : ''}#repository-access`;
}

/** The default for repositories that inherit their source's policy. */
export function SourceDefaultAccess({ host }: { host: string }) {
  const inventory = useAgentAccess();
  const { editable, setDefault } = useAgentAccessActions();
  const toast = useToast();
  const source = inventory.data?.sources.find((item) => item.host === host);
  if (!source) return <span className="muted">{inventory.isPending ? 'Loading…' : 'Unavailable'}</span>;
  if (!editable) return <span>{ACCESS_STATE[source.defaultAccess]}</span>;
  return (
    <select
      className="wb-input wb-input--sm wb-input--auto"
      aria-label={`Default repository access on ${host}`}
      value={source.defaultAccess}
      disabled={setDefault.isPending}
      onChange={(event) => {
        const access = event.target.value as SourceAgentAccess;
        setDefault.mutate({ host, access }, { onError: (error) => toast(bridgeError(error), { tone: 'error' }) });
      }}
    >
      <option value="block">Block</option>
      <option value="allow">Allow</option>
    </select>
  );
}

export function SourceRepositoryAccess({ host }: { host: string }) {
  return (
    <div className="agent-access-controls" title="Through gh-dash. Applies to newly tracked repositories and repositories that use the source default.">
      <SourceDefaultAccess host={host} />
      <Link to={repositoryAccessUrl(host)} aria-label={`Manage repository access on ${host}`}>Manage repositories</Link>
    </div>
  );
}

type Repository = AgentAccessInventory['repos'][number];

export function RepositoryAccessChoice({ repo, defaultAccess, disabled, onChange }: {
  repo: Repository;
  defaultAccess: SourceAgentAccess;
  disabled?: boolean;
  onChange?: (access: RepoAgentAccess) => void;
}) {
  if (!onChange) return (
    <span>{repo.access === 'inherit' ? `${ACCESS_STATE[defaultAccess]} (source default)` : ACCESS_STATE[repo.access]}</span>
  );
  return (
    <select
      className="wb-input wb-input--sm wb-input--auto"
      aria-label={`Agent access through gh-dash for ${repo.key}`}
      value={repo.access}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as RepoAgentAccess)}
    >
      <option value="inherit">Use source default ({ACCESS_STATE[defaultAccess].toLowerCase()})</option>
      <option value="allow">Allow</option>
      <option value="block">Block</option>
    </select>
  );
}

/** The single-repository control next to the repository's other settings. */
export function RepositoryAgentAccess({ repoKey }: { repoKey: string }) {
  const inventory = useAgentAccess();
  const { editable, setRepositories } = useAgentAccessActions();
  const toast = useToast();
  const repo = inventory.data?.repos.find((item) => item.key === repoKey);
  const source = inventory.data?.sources.find((item) => item.host === repo?.source);
  return (
    <div className="agent-access-controls">
      <span className="muted">Agent access through gh-dash</span>
      {repo && source ? (
        <RepositoryAccessChoice repo={repo} defaultAccess={source.defaultAccess} disabled={setRepositories.isPending}
          onChange={editable ? (access) => setRepositories.mutate({ ids: [repo.id], access }, {
            onError: (error) => toast(bridgeError(error), { tone: 'error' }),
          }) : undefined} />
      ) : <span className="muted">{inventory.isPending ? 'Loading…' : 'Unavailable'}</span>}
    </div>
  );
}
