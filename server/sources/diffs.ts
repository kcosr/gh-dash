// The diff service's DiffSources over the SourceRegistry (design §5): a fetch about a repo goes to the DiffSource of the
// source the repo is on, so one server serves github.com and every GitLab instance it is configured for.

import type { DiffSources, SourceDiffSupply } from '../diff/service';
import { SourceError } from '../provider/errors';
import type { DiffSource } from '../provider/types';
import type { SourceRegistry } from './registry';

/**
 * Routes `get(repo)` to `registry.byId(repo.sourceId).diffs` and `authFailed(source)` back to the supply that made
 * `source`, so a rejected token is invalidated on its own source and no other. A source this server isn't configured
 * for (its row is in the database, say from another instance or before its config was removed) has no credential to
 * ask with: the service answers 503 with the reason, which names it.
 */
export class DiffRouter implements DiffSources {
  private readonly registry: Pick<SourceRegistry, 'byId'>;
  /** The supply that handed out each source, for authFailed: by then the supply may have moved on to a newer one. */
  private readonly makers = new WeakMap<DiffSource, SourceDiffSupply>();

  constructor(registry: Pick<SourceRegistry, 'byId'>) {
    this.registry = registry;
  }

  async get(repo: { sourceId: number }): Promise<DiffSource> {
    const runtime = this.registry.byId(repo.sourceId);
    if (!runtime) throw new SourceError('auth', "This repository's source isn't known on this server");
    if (!runtime.configured) {
      throw new SourceError('auth', `No ${runtime.tokens.spec.name} credential is configured on this server for ${runtime.host}`);
    }
    const source = await runtime.diffs.get();
    this.makers.set(source, runtime.diffs);
    return source;
  }

  authFailed(source: DiffSource): void {
    this.makers.get(source)?.authFailed(source);
  }
}
