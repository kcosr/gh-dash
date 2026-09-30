// gh-dash's MCP server: the protocol core with every tool, as one app instance serves it at /mcp.

import { McpCore } from './core';
import type { McpDeps, Tool } from './tool';
import { getBranch, listBranches } from './tools/branches';
import { addComment, deleteComment, editComment, reopenThread, reply, resolveThread } from './tools/comments';
import { show, waitForReply } from './tools/live';
import { findPr, getPr, listPrs } from './tools/prs';
import { listRepos, resolveRepo, whoami } from './tools/repos';
import { getThreadTool, listThreads } from './tools/threads';

/** In the order tools/list gives them: finding things first, then reading threads, then writing and waiting. */
export const TOOLS: readonly Tool[] = [
  whoami, listRepos, resolveRepo, listPrs, findPr, getPr, listBranches, getBranch, listThreads, getThreadTool,
  addComment, reply, editComment, deleteComment, resolveThread, reopenThread, waitForReply, show,
];

/** What initialize tells the agent about gh-dash (clients show it to the model once, with the tools). */
export const INSTRUCTIONS = [
  "gh-dash is the user's dashboard for their GitHub and GitLab repositories, with review comments on pull requests",
  '(GitLab: merge requests), pushed branches and commits. Comments live in gh-dash only: nothing is posted to GitHub or',
  "GitLab. Yours are attributed to you, and the user reads and answers them in gh-dash's diff view.",
  'Typical use in a local clone: resolve_repo with `git remote get-url origin`, find_pr with the current branch,',
  'list_threads with waiting_on "me" for what the user asked, then reply (or fix the code and resolve_thread), and',
  'wait_for_reply for their answer. add_comment annotates the diff (a PR, at its head: path and start_line). A pushed',
  'branch with no PR is reviewed the same way (get_branch, then add_comment and list_threads with branch); its threads',
  'are shared with a PR later opened from it.',
  'In results, `by` is "me" (you), "you" (the user) or "agent:<name>" (another agent).',
].join(' ');

export function createMcpCore(deps: McpDeps, log?: (line: string) => void): McpCore {
  return new McpCore({ deps, tools: TOOLS, instructions: INSTRUCTIONS, log });
}
