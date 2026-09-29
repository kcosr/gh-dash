// How tool results name people, targets and text: compact, and from the agent's side ("me" is the calling agent,
// "you" the person using gh-dash).

import { z } from 'zod';
import type { Principal, ProviderKind } from '../../shared/api';
import { refText } from '../../shared/provider';

/** Who wrote something, as the calling agent reads it: "me", "you" (the user), or "agent:<name>" for another agent. */
export function byOf(p: Pick<Principal, 'id' | 'kind' | 'name'>, me: Principal): string {
  if (p.id === me.id) return 'me';
  return p.kind === 'self' ? 'you' : `agent:${p.name}`;
}

/** `text` on one line, cut to `max` characters with an ellipsis. */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `text` trimmed and cut to `max` characters with a note of what was left out (line breaks kept, unlike excerpt). */
export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}… (${t.length - max} more characters)` : t;
}

/** A PR as its host writes it (`alice/app#2`, `gitlab.example.com/g/app!2`), or a commit (`alice/app@1a2b3c4`). */
export function targetRef(kind: ProviderKind, repo: string, target: { number: number } | { oid: string }): string {
  return 'number' in target ? refText(kind, repo, target.number, 'pr') : `${repo}@${target.oid.slice(0, 7)}`;
}

// Argument schemas shared by the tools. Descriptions are what the agent reads next to each parameter.

export const repoArg = z
  .string()
  .min(1)
  .max(1000)
  .describe('Repository key: "owner/name" on github.com, "<host>/<path>" elsewhere (list_repos, resolve_repo)');
export const prArg = z.number().int().min(1).max(2 ** 31).describe('PR (or GitLab MR) number');
export const commitArg = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/i, 'expected a commit SHA (7 to 64 hex characters)')
  .transform((s) => s.toLowerCase())
  .describe('Commit SHA (full, or at least 7 characters)');
export const idArg = (what: string) => z.number().int().min(1).max(2 ** 53 - 1).describe(what);
export const bodyArg = z
  .string()
  .max(65_536)
  .refine((s) => s.trim() !== '', 'must not be empty')
  .describe('Markdown');
export const limitArg = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt).describe(`At most this many (default ${dflt}, max ${max})`);
