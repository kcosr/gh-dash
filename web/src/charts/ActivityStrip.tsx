import { useMemo } from 'react';
import type { ActivityStripProps } from './index';
import { useElementWidth, useFontsVersion, useIndexInteraction } from './hooks';
import { TipPortal } from './tooltip';
import {
  RADIUS, bandLabels, clamp, colPath, columnWidth, fmtNum, formatLongDate, formatShortDate, parseDay, type AxisLabel,
} from './util';

const MT = 4;
const MB = 18; // date label band

interface Geo {
  band: number;
  base: number;
  ih: number;
  cols: { top: number; d: string; zero: boolean }[];
  labels: AxisLabel[];
  withYear: boolean;
}

function layout(days: ActivityStripProps['days'], width: number, height: number, sel: number | null): Geo {
  const n = days.length;
  const ih = Math.max(8, height - MT - MB);
  const base = MT + ih;
  const band = width / n;
  const bw = columnWidth(band);
  const max = Math.max(0, ...days.map((d) => d.count));
  const cols = days.map((d, i) => {
    const x = band * i + (band - bw) / 2;
    if (!(d.count > 0) || max === 0) return { top: base - 1, d: colPath(x, base - 1, bw, 1, 0), zero: true };
    const h = Math.max(2, (d.count / max) * ih);
    return { top: base - h, d: colPath(x, base - h, bw, h, Math.min(RADIUS, 3)), zero: false };
  });

  // Date labels: whole-week steps back from the latest day (at most ~8); the selected day always wins.
  const texts = days.map((d) => formatShortDate(d.date));
  const minEvery = n > 14 ? 7 * Math.ceil(n / 8 / 7) : 1;
  const labels = bandLabels(texts, (i) => band * (i + 0.5), band, width, sel, 24, minEvery);
  const first = parseDay(days[0].date);
  const last = parseDay(days[n - 1].date);
  return { band, base, ih, cols, labels, withYear: first.y !== last.y };
}

/**
 * Compact per-day histogram above the activity feed. No selection: every day in --wb-s1. With a
 * selected day: emphasis form (selected --wb-s1, the rest --wb-deemph) and its date label is pinned.
 */
export function ActivityStrip({
  days, ariaLabel, selected = null, onSelect, height = 56, unit = 'events', emptyText = 'No activity in this range',
}: ActivityStripProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fontsV = useFontsVersion();
  const n = days.length;
  const selIndex = useMemo(() => (selected ? days.findIndex((d) => d.date === selected) : -1), [days, selected]);
  const sel = selIndex >= 0 ? selIndex : null;
  const geo = useMemo(
    () => (width > 0 && n > 0 ? layout(days, width, height, sel) : null),
    [days, width, height, sel, fontsV], // fontsV: re-measure once web fonts load
  );
  const allZero = n > 0 && days.every((d) => !(d.count > 0));

  const ia = useIndexInteraction({
    n: geo ? n : 0,
    indexAt: (px) => (geo ? clamp(Math.floor(px / geo.band), 0, n - 1) : null),
    tip: (i) => ({
      title: days[i].title ?? formatLongDate(days[i].date, geo?.withYear),
      rows: [{ color: sel == null || i === sel ? 'var(--wb-s1)' : 'var(--wb-deemph)', value: fmtNum(days[i].count), label: unit }],
    }),
    anchor: (i) => (geo ? { x: geo.band * (i + 0.5), y: geo.cols[i].top } : { x: 0, y: 0 }),
    onActivate: onSelect ? (i) => onSelect(days[i].date) : null,
    initial: () => sel ?? n - 1,
  });

  const fill = (i: number, zero: boolean) =>
    zero ? 'var(--wb-grid)' : sel == null || i === sel ? 'var(--wb-s1)' : 'var(--wb-deemph)';

  const columns = useMemo(
    () =>
      geo && (
        <g>
          {geo.cols.map((c, i) => <path key={i} d={c.d} style={{ fill: fill(i, c.zero) }} />)}
        </g>
      ),
    // fill depends only on sel
    [geo, sel],
  );
  const labels = useMemo(
    () =>
      geo && (
        <g>
          {geo.labels.map((l) => (
            <text key={l.i} className={'xl' + (l.strong ? ' strong' : '')} x={l.x} y={height - 4} textAnchor={l.anchor}>{l.text}</text>
          ))}
        </g>
      ),
    [geo, height],
  );

  const a = ia.active;
  return (
    <div ref={ref} className={'gd-chart gd-strip' + (onSelect ? ' clickable' : '')} style={{ height }}>
      {geo && (
        <svg
          ref={ia.svgRef}
          className="chart"
          width={width}
          height={height}
          style={{ width, height }}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          {...ia.handlers}
        >
          {sel != null && <rect className="gd-wash sel" x={geo.band * sel} y={0} width={geo.band} height={geo.base + 2} rx={Math.min(3, geo.band / 3)} />}
          {a != null && a !== sel && <rect className="gd-wash" x={geo.band * a} y={0} width={geo.band} height={geo.base + 2} rx={Math.min(3, geo.band / 3)} />}
          {columns}
          {a != null && !geo.cols[a].zero && (
            <path
              d={geo.cols[a].d}
              pointerEvents="none"
              className={'gd-lift' + (fill(a, false).includes('deemph') ? ' muted' : '')}
              style={{ fill: fill(a, false) }}
            />
          )}
          {labels}
        </svg>
      )}
      {width > 0 && (n === 0 || allZero) && (
        <div className="gd-empty" style={{ bottom: MB }}><span>{emptyText}</span></div>
      )}
      <div className="gd-sr" aria-live="polite">{ia.live}</div>
      <TipPortal owner={ia.owner} />
    </div>
  );
}
