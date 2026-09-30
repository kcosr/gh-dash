import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { CommentThread } from '../../../shared/api';
import { plainPreview } from '../lib/markdown';
import { threadLines, threadPlace } from '../lib/threadList';
import { plural } from '../lib/time';
import { cx } from '../lib/util';
import { AgentMark } from './bits';
import { Icon } from './Icon';

export { threadLines, threadPlace } from '../lib/threadList';

/**
 * One comment thread as a line (the drawer's Comments, the Comments list): where (the file's name, its path in the
 * title; "General" for one on the whole PR, branch or commit), who opened it when an agent did, the first comment's
 * opening words, the replies. A click opens the diff at the thread. `before` and `after` add to the line (what it is on,
 * when, tags).
 */
export function ThreadRow({ thread: t, onOpen, before, after, className, ...rest }: {
  thread: CommentThread;
  onOpen: () => void;
  before?: ReactNode;
  after?: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'type'>) {
  const first = t.comments[0]!;
  const lines = threadLines(t);
  const resolved = t.status === 'resolved';
  const replies = t.comments.length - 1;
  return (
    <button type="button" className={cx('th-li', resolved && 'resolved', className)} onClick={onOpen}
      title={`${threadPlace(t)}${resolved ? ' · resolved' : ''} · open the diff at this thread`} {...rest}>
      <Icon name={resolved ? 'check' : 'comment'} />
      {before}
      <span className="th-where"><span className="name">{t.path === null ? 'General' : t.path.slice(t.path.lastIndexOf('/') + 1)}</span>{lines && <span className="ln">{lines}</span>}</span>
      {first.author.kind === 'agent' && <span className="th-by"><span className="nm">{first.author.name}</span><AgentMark /></span>}
      <span className="th-text">{plainPreview(first.body, 200)}</span>
      {replies > 0 && <span className="th-n" title={`${replies} ${plural(replies, 'reply', 'replies')}`}>+{replies}</span>}
      {after}
    </button>
  );
}
