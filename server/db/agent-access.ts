import type { AgentAccessInventory, RepoAgentAccess, SourceAgentAccess } from '../../shared/agent-access';
import { HttpError } from '../lib/errors';
import type { Db } from './db';

/** SQL for whether a live repository permits MCP access, independently of an individual agent's source limits. */
export function repoAgentAccessSql(alias: string): string {
  return `(${alias}.removed_at IS NULL AND coalesce(${alias}.agent_access,
    (SELECT s.agent_access FROM sources s WHERE s.id = ${alias}.source_id)) = 'allow')`;
}

export function listAgentAccess(db: Db): AgentAccessInventory {
  const sources = db.all<AgentAccessInventory['sources'][number]>(
    'SELECT host, name, agent_access AS defaultAccess FROM sources ORDER BY id',
  );
  const repos = db.all<AgentAccessInventory['repos'][number]>(
    `SELECT r.id, r.key, s.host AS source, r.name_with_owner AS nameWithOwner, coalesce(r.agent_access, 'inherit') AS access
     FROM repos r JOIN sources s ON s.id = r.source_id WHERE r.removed_at IS NULL
     ORDER BY s.id, r.name_with_owner COLLATE NOCASE, r.id`,
  );
  return { sources, repos };
}

export function setSourceAgentAccess(db: Db, host: string, access: SourceAgentAccess): void {
  const { changes } = db.run('UPDATE sources SET agent_access = ? WHERE host = ?', [access, host.trim().toLowerCase()]);
  if (changes === 0) throw new HttpError(404, `Source ${host} not found`);
}

/** Apply a bulk edit to live repository identities atomically. A renamed repo keeps its identity. */
export function setRepoAgentAccess(db: Db, ids: readonly number[], access: RepoAgentAccess): void {
  const selected = [...new Set(ids)];
  db.tx(() => {
    const { changes } = db.run(
      `UPDATE repos SET agent_access = ? WHERE removed_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
      [access === 'inherit' ? null : access, JSON.stringify(selected)],
    );
    if (changes !== selected.length) throw new HttpError(404, 'One or more selected repositories are no longer tracked');
  });
}
