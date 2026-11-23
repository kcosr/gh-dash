/** Access to tracked repositories through gh-dash MCP. The repository can inherit its source's default. */
export type SourceAgentAccess = 'allow' | 'block';
export type RepoAgentAccess = SourceAgentAccess | 'inherit';

export interface AgentAccessInventory {
  sources: { host: string; name: string; defaultAccess: SourceAgentAccess }[];
  repos: { id: number; key: string; source: string; nameWithOwner: string; access: RepoAgentAccess }[];
}
