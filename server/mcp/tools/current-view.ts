import { z } from 'zod';
import { agentSourceIds, getAgent } from '../../db/agents';
import { resolveRepo } from '../../db/repo-key';
import { HttpError } from '../../lib/errors';
import { reaches } from '../reach';
import { readTool } from '../tool';

export const getCurrentView = readTool({
  name: 'get_current_view',
  title: 'Read the current review view',
  description:
    'When the user asks about what they are viewing or have selected in gh-dash, read the most recently focused live window. ' +
    'Returns the review, displayed Git revisions, current file, visible line ranges, focused thread, and active code ' +
    'selection when available. Returns a null view when no review is available within your source scope. ' +
    'Requires the user to enable view sharing for your agent. This reads the view without changing it or starting a discussion.',
  input: z.strictObject({}),
  run: async (_, { deps: { db, bus }, principal, sources, signal }) => {
    const requirePermission = () => {
      const agent = getAgent(db, principal.id);
      if (!agent?.shareView || agent.builtIn || agent.disabledAt !== null) {
        throw new HttpError(403, 'Current view sharing is off for this agent');
      }
    };
    requirePermission();
    const view = await bus.currentView(signal);
    requirePermission();
    const repo = view && resolveRepo(db, view.target.repo);
    // Check the chosen window after ranking it, so a different window can't be used in its place. A permission
    // change while the browser answers can only narrow access for this call.
    if (!repo || !reaches(sources, repo.sourceId) || !reaches(agentSourceIds(db, principal.id), repo.sourceId)) return { view: null };
    return { view };
  },
});
