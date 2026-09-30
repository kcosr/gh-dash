/**
 * Deleting an agent (the desktop app's Settings → Agents, the headless `agents delete`): the name it leaves behind, what
 * it had written, and how the warning before it says so. Shared by the server, which deletes it (and whose command
 * prints the warning), and the web app, which shows it.
 *
 * A deleted agent's principal stays, so its comments, their events and the threads it resolved keep pointing at it. It
 * is renamed "Deleted agent #<id>", which is what everything that names a principal shows from then on. No agent may be
 * given a name of that pattern (any case), so a deleted agent's name never collides with another's, and its old name
 * is free for a new agent.
 */

/** What every deleted agent's name starts with, before its id. */
export const DELETED_AGENT_PREFIX = 'Deleted agent #';

/** A deleted agent's name: "Deleted agent #4". */
export const deletedAgentName = (id: number): string => `${DELETED_AGENT_PREFIX}${id}`;

/** The names kept for deleted agents (any case): an agent can't be given one. */
export const DELETED_AGENT_NAME = /^deleted agent #\d+$/i;

/** What an agent has written, for the warning before it is deleted. */
export interface AgentFootprint {
  /** Its comments. */
  comments: number;
  /** The threads they are in. */
  threads: number;
  /** Those threads that are still open. */
  openThreads: number;
  /** The threads it opened (their first comment is its). */
  opened: number;
}

/** An agent just deleted: its id, the name it had, the one it has now, and what it had written. */
export interface DeletedAgent {
  id: number;
  name: string;
  deletedAs: string;
  footprint: AgentFootprint;
}

/** A sentence of the warning. `stress`: the one to make stand out a little (threads still open). */
export interface WarningSentence {
  text: string;
  stress?: boolean;
}

/**
 * What deleting an agent does, in the sentences that follow its question ("Delete Claude?"): its comments stay, shown
 * under its deleted name; how many of their threads are still open; what becomes of its token (it stops working, or,
 * disabled already, goes too); and, when it has written anything, that this can't be undone. `done`: the same, said
 * once it's done (`agents delete`), without the last.
 */
export function agentDeletionSentences(agent: { id: number; disabled: boolean }, f: AgentFootprint, done = false): WarningSentence[] {
  const token = agent.disabled
    ? { text: done ? 'Its token was deleted with it.' : 'Its token is deleted with it.' }
    : { text: done ? 'Its token no longer works.' : 'Its token stops working now.' };
  if (f.comments === 0) return [{ text: done ? "It hadn't written anything." : "It hasn't written anything." }, token];
  const as = `shown as by “${deletedAgentName(agent.id)}”`;
  const kept = f.comments === 1
    ? `Its comment stays, ${as}.`
    : `Its ${f.comments} comments in ${f.threads === 1 ? 'one thread' : `${f.threads} threads`} stay, ${as}.`;
  const out: WarningSentence[] = [{ text: kept }];
  if (f.openThreads > 0) out.push({ text: openText(f.openThreads, f.threads), stress: true });
  out.push(token);
  if (!done) out.push({ text: "This can't be undone." });
  return out;
}

/** "That thread is still open.", "3 of those threads are still open.", "Both of…", "All 5 of…". */
function openText(open: number, threads: number): string {
  if (threads === 1) return 'That thread is still open.';
  const which = open < threads ? String(open) : threads === 2 ? 'Both' : `All ${threads}`;
  return `${which} of those threads ${open === 1 ? 'is' : 'are'} still open.`;
}

/** The sentences as one line of text. */
export const warningText = (sentences: readonly WarningSentence[]): string => sentences.map((s) => s.text).join(' ');
