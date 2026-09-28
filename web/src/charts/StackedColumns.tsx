import { useMemo } from 'react';
import type { ColumnDatum, SeriesDef, StackedColumnsProps } from './index';
import { useElementWidth, useFontsVersion, useIndexInteraction } from './hooks';
import { TipPortal, type TipData, type TipRow } from './tooltip';
import {
  GAP, RADIUS, bandLabels, colPath, columnWidth, fmtNum, intervalsFor, niceScale, textWidth, type AxisLabel,
} from './util';

const MT = 8;
const MB = 24;
const MR = 2;

interface Geo {
  ml: number;
  mt: number;
  ih: number;
  base: number;
  band: number;
  bw: number;
  ticks: { v: number; y: number; label: string }[];
  cols: { x: number; top: number; segs: { d: string; color: string }[] }[];
  labels: AxisLabel[];
  allZero: boolean;
}

function layout(
  data: ColumnDatum[], series: SeriesDef[], width: number, height: number, hl: number | null,
  fmt: (v: number) => string,
): Geo {
  const ih = Math.max(16, height - MT - MB);
  const base = MT + ih;
  const val = (d: ColumnDatum, s: SeriesDef) => Math.max(0, d.values[s.key] ?? 0) || 0;
  const totals = data.map((d) => series.reduce((t, s) => t + val(d, s), 0));
  const maxT = Math.max(0, ...totals);
  const integer = data.every((d) => series.every((s) => Number.isInteger(val(d, s))));
  const sc = niceScale(0, maxT, { zero: true, integer, maxIntervals: intervalsFor(ih) });
  const tickLabels = sc.ticks.map((t) => (sc.decimals ? fmtNum(t, sc.decimals) : fmt(t)));
  const ml = Math.ceil(Math.max(...tickLabels.map((l) => textWidth(l, 11)))) + 10;
  const iw = Math.max(1, width - ml - MR);
  const n = data.length;
  const band = iw / n;
  const bw = columnWidth(band);
  const k = ih / (sc.hi - sc.lo);
  const y = (v: number) => base - (v - sc.lo) * k;

  const cols = data.map((d, i) => {
    const x = ml + band * i + (band - bw) / 2;
    const vis = series.filter((s) => val(d, s) > 0);
    const segs: { d: string; color: string }[] = [];
    let y0 = base;
    vis.forEach((s, j) => {
      const h = val(d, s) * k;
      const top = y0 - h;
      const bottom = j ? y0 - GAP : y0;
      const sh = Math.max(1, bottom - top);
      segs.push({ d: colPath(x, bottom - sh, bw, sh, j === vis.length - 1 ? RADIUS : 0), color: s.color });
      y0 = top;
    });
    return { x, top: y0, segs };
  });

  const labels = bandLabels(data.map((d) => d.label), (i) => ml + band * (i + 0.5), band, width, hl);
  return {
    ml, mt: MT, ih, base, band, bw, cols, labels, allZero: maxT === 0,
    ticks: sc.ticks.map((v, i) => ({ v, y: Math.round(y(v)) + 0.5, label: tickLabels[i] })),
  };
}

function columnTip(d: ColumnDatum, series: SeriesDef[], fmt: (v: number) => string): TipData {
  const rows: TipRow[] = series.map((s) => ({ color: s.color, value: fmt(d.values[s.key] ?? 0), label: s.label }));
  if (series.length > 1) {
    const total = series.reduce((t, s) => t + (d.values[s.key] ?? 0), 0);
    rows.push({ value: fmt(total), label: 'Total', total: true });
  }
  return { title: d.title, rows };
}

export function StackedColumns({
  data, series, height = 220, ariaLabel, onColumnClick, highlightIndex = null,
  formatValue = fmtNum, emptyText = 'No activity in this range',
}: StackedColumnsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fontsV = useFontsVersion();
  const n = data.length;
  const hl = highlightIndex != null && highlightIndex >= 0 && highlightIndex < n ? highlightIndex : null;

  const geo = useMemo(
    () => (width > 0 && n > 0 ? layout(data, series, width, height, hl, formatValue) : null),
    [data, series, width, height, hl, formatValue, fontsV],
  );

  const ia = useIndexInteraction({
    n,
    indexAt: (px) => {
      if (!geo || px < geo.ml - 4) return null;
      return Math.max(0, Math.min(n - 1, Math.floor((px - geo.ml) / geo.band)));
    },
    tip: (i) => columnTip(data[i], series, formatValue),
    anchor: (i) => (geo ? { x: geo.ml + geo.band * (i + 0.5), y: Math.max(geo.mt, geo.cols[i].top) } : { x: 0, y: 0 }),
    onActivate: onColumnClick,
    initial: () => hl ?? n - 1,
  });

  // Static layers are memoized so hover only re-renders the overlay.
  const grid = useMemo(
    () =>
      geo && (
        <g>
          {geo.ticks.map((t) => (
            <g key={t.v}>
              <line className={t.v === 0 ? 'axis' : 'grid'} x1={geo.ml} x2={width - MR} y1={t.y} y2={t.y} />
              <text className="tick" x={geo.ml - 8} y={t.y + 3.5} textAnchor="end">{t.label}</text>
            </g>
          ))}
        </g>
      ),
    [geo, width],
  );
  const columns = useMemo(
    () =>
      geo && (
        <g>
          {geo.cols.map((c, i) => (
            <g key={i} className={hl != null && i !== hl ? 'gd-dim' : undefined}>
              {c.segs.map((s, j) => <path key={j} d={s.d} style={{ fill: s.color }} />)}
            </g>
          ))}
        </g>
      ),
    [geo, hl],
  );
  const xLabels = useMemo(
    () =>
      geo && (
        <g>
          {geo.labels.map((l) => (
            <text key={l.i} className={'xl' + (l.strong ? ' strong' : '')} x={l.x} y={height - 6} textAnchor="middle">{l.text}</text>
          ))}
        </g>
      ),
    [geo, height],
  );

  const a = ia.active;
  const muted = (color: string) => color.includes('--deemph');
  return (
    <div ref={ref} className={'gd-chart' + (onColumnClick ? ' clickable' : '')} style={{ height }}>
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
          {grid}
          {hl != null && <rect className="gd-wash sel" x={geo.ml + geo.band * hl} y={geo.mt - 4} width={geo.band} height={geo.ih + 4} rx={Math.min(4, geo.band / 3)} />}
          {a != null && a !== hl && <rect className="gd-wash" x={geo.ml + geo.band * a} y={geo.mt - 4} width={geo.band} height={geo.ih + 4} rx={Math.min(4, geo.band / 3)} />}
          {columns}
          {a != null && (
            <g pointerEvents="none">
              {geo.cols[a].segs.map((s, j) => (
                <path key={j} d={s.d} className={'gd-lift' + (muted(s.color) ? ' muted' : '')} style={{ fill: s.color }} />
              ))}
            </g>
          )}
          {xLabels}
        </svg>
      )}
      {(n === 0 || geo?.allZero) && (
        <div className="gd-empty" style={geo ? { top: geo.mt, height: geo.ih, bottom: 'auto' } : undefined}><span>{emptyText}</span></div>
      )}
      <div className="gd-sr" aria-live="polite">{ia.live}</div>
      <TipPortal owner={ia.owner} />
    </div>
  );
}
