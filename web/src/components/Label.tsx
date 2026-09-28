import type { CSSProperties } from 'react';
import type { Label as GhLabel } from '../../../shared/api';

type RGB = [number, number, number];

// Theme values the pill is drawn with (app.css): text is mixed toward --text (light) or white
// (dark); the pill background is the label color at 12% / 20% over --surface.
const LIGHT = { toward: [11, 11, 11] as RGB, surface: [252, 252, 251] as RGB, bg: 0.12, share: 0.72 };
const DARK = { toward: [255, 255, 255] as RGB, surface: [26, 26, 25] as RGB, bg: 0.2, share: 0.55 };

const mix = (a: RGB, b: RGB, p: number): RGB => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as RGB;
const lum = (c: RGB) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/**
 * Largest share of the label's own color in the text (the design default, or less) that still
 * reads at >= 4.6:1 on the pill. GitHub label colors are arbitrary: very light ones (ededed) vanish
 * on the light theme and black ones on the dark theme at the default mix.
 */
function textShare(c: RGB, t: typeof LIGHT): number {
  const bg = mix(c, t.surface, t.bg);
  for (let p = t.share; p > 0; p -= 0.08) if (contrast(mix(c, t.toward, p), bg) >= 4.6) return p;
  return 0;
}

const cache = new Map<string, CSSProperties>();
function pillStyle(hex: string): CSSProperties {
  let st = cache.get(hex);
  if (!st) {
    const h = hex.length === 3 ? [...hex].map((x) => x + x).join('') : hex.slice(0, 6);
    const c: RGB = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
    st = {
      '--lc': `#${h}`,
      '--lc-l': `${Math.round(textShare(c, LIGHT) * 100)}%`,
      '--lc-d': `${Math.round(textShare(c, DARK) * 100)}%`,
    } as CSSProperties;
    cache.set(hex, st);
  }
  return st;
}

/** GitHub label pill using the label's own color. */
export function LabelPill({ label }: { label: GhLabel }) {
  const style = /^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(label.color) ? pillStyle(label.color.toLowerCase()) : pillStyle('898781');
  return <span className="label" style={style}>{label.name}</span>;
}

export function Labels({ labels }: { labels: GhLabel[] }) {
  if (!labels.length) return null;
  return <span className="labels">{labels.map((l) => <LabelPill key={l.name} label={l} />)}</span>;
}
