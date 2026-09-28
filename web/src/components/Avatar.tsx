import type { CSSProperties } from 'react';
import type { Actor } from '../../../shared/api';
import { actorName } from '../lib/util';

const AV_COLORS = ['#6e7781', '#8c6d3f', '#5b7f95', '#7a6a9c', '#5f8a6b', '#9a6060', '#4f7f7f', '#8a7550', '#6b6f9a'];
const avColor = (s: string) => AV_COLORS[[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AV_COLORS.length];

/**
 * Letter avatar, as in the mock. Deliberately no <img>: GitHub avatar URLs would be
 * external requests. The viewer gets the accent color.
 */
export function Avatar({ actor, size = 16 }: { actor: Actor | null | undefined; size?: number }) {
  const name = actorName(actor);
  const style = {
    '--av': actor?.isMe ? 'var(--accent)' : avColor(name),
    width: size,
    height: size,
    fontSize: Math.round(size * 0.52),
  } as CSSProperties;
  const title = actor?.name && actor.login && actor.name !== actor.login ? `${actor.name} (${actor.login})` : name;
  return <span className="avatar" title={title} style={style}>{(name[0] ?? '?').toUpperCase()}</span>;
}

export function AvatarStack({ actors, max = 4 }: { actors: Actor[]; max?: number }) {
  return (
    <span className="stack">
      {actors.slice(0, max).map((a, i) => <Avatar key={`${actorName(a)}-${i}`} actor={a} size={18} />)}
    </span>
  );
}
