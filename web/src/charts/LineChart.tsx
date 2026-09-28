import { useMemo } from 'react';
import type { LineChartProps, LinePoint } from './index';
import { useElementWidth, useFontsVersion, useIndexInteraction } from './hooks';
import { TipPortal, type TipData, type TipRow } from './tooltip';
import { clamp, dropCollisions, fmtNum, intervalsFor, niceScale, r2, textWidth, type AxisLabel } from './util';

const MT = 12;
const MB = 24;

interface Geo {
  ml: number;
  mr: number;
  iw: number;
  ih: number;
  base: number;
  xs: number[];
  ys: (number | null)[];
  ticks: { v: number; y: number; label: string; axis: boolean }[];
  line: string;
  area: string;
  lone: number[];
  end: { i: number; x: number; y: number; value: string; nounY: number } | null;
  labels: AxisLabel[];
}

function layout(
  points: LinePoint[], width: number, height: number, zeroBased: boolean, noun: string, fmt: (v: number) => string,
): Geo | null {
  const n = points.length;
  const finite = points.map((p) => Number.isFinite(p.value));
  const vals = points.filter((_, i) => finite[i]).map((p) => p.value);
  if (!vals.length) return null;
  const ih = Math.max(16, height - MT - MB);
  const base = MT + ih;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const sc = niceScale(min, max, {
    zero: zeroBased, integer: vals.every(Number.isInteger), nonNegative: min >= 0, maxIntervals: intervalsFor(ih),
  });
  const tickLabels = sc.ticks.map((t) => (sc.decimals ? fmtNum(t, sc.decimals) : fmt(t)));
  const ml = Math.ceil(Math.max(...tickLabels.map((l) => textWidth(l, 11)))) + 10;

  let L = n - 1;
  while (L > 0 && !finite[L]) L--;
  const endValue = fmt(points[L].value);
  const endW = Math.max(textWidth(endValue, 12, 600), noun ? textWidth(noun, 11) : 0);
  const mr = Math.ceil(endW) + 14;
  const iw = Math.max(1, width - ml - mr);
  const x = (i: number) => (n === 1 ? ml + iw / 2 : ml + (i / (n - 1)) * iw);
  const y = (v: number) => base - ((v - sc.lo) / (sc.hi - sc.lo)) * ih;
  const xs = points.map((_, i) => x(i));
  const ys = points.map((p, i) => (finite[i] ? y(p.value) : null));

  // Contiguous runs of finite values (NaN = no data -> gap in the line).
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < n; i++) {
    if (finite[i]) run.push(i);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  let line = '';
  let area = '';
  const lone: number[] = [];
  for (const r of runs) {
    if (r.length === 1) {
      if (r[0] !== L) lone.push(r[0]);
      continue;
    }
    const seg = r.map((i, k) => `${k ? 'L' : 'M'}${r2(xs[i])},${r2(ys[i]!)}`).join('');
    line += seg;
    area += `${seg}L${r2(xs[r[r.length - 1]])},${base}L${r2(xs[r[0]])},${base}Z`;
  }

  const ey = ys[L]!;
  const nounBelow = ey + 17 <= height - 2;
  const end = { i: L, x: xs[L], y: ey, value: endValue, nounY: nounBelow ? ey + 17 : ey - 11 };

  // X labels: up to 7, evenly spread; first/last hug the plot edges.
  const widths = points.map((p) => textWidth(p.label, 11));
  const maxW = Math.max(...widths);
  let k = n === 1 ? 1 : clamp(Math.floor(iw / (maxW + 28)) + 1, 2, 7);
  k = Math.min(k, n);
  const idx = [...new Set(Array.from({ length: k }, (_, j) => (k === 1 ? 0 : Math.round((j / (k - 1)) * (n - 1)))))];
  const labels = dropCollisions(
    idx.map((i) => ({
      i, x: xs[i], text: points[i].label, w: widths[i],
      anchor: n === 1 ? ('middle' as const) : i === 0 ? ('start' as const) : i === n - 1 ? ('end' as const) : ('middle' as const),
    })),
  );

  return {
    ml, mr, iw, ih, base, xs, ys, line, area, lone, end, labels,
    ticks: sc.ticks.map((v, i) => ({ v, y: Math.round(y(v)) + 0.5, label: tickLabels[i], axis: i === 0 })),
  };
}

export function LineChart({
  points, valueLabel, height = 220, ariaLabel, zeroBased = false, color = 'var(--s1)', area = true,
  formatValue = fmtNum, emptyText = 'No data in this range',
}: LineChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fontsV = useFontsVersion();
  const n = points.length;
  const geo = useMemo(
    () => (width > 0 && n > 0 ? layout(points, width, height, zeroBased, valueLabel, formatValue) : null),
    // fontsV: re-measure labels once web fonts load
    [points, width, height, zeroBased, valueLabel, formatValue, fontsV],
  );

  const tip = (i: number): TipData => {
    const p = points[i];
    const ok = Number.isFinite(p.value);
    const rows: TipRow[] = [ok ? { color, value: formatValue(p.value), label: valueLabel } : { value: '—', label: 'no data' }];
    for (const e of p.extra ?? []) rows.push({ value: e.value, label: e.label });
    return { title: p.title, rows };
  };

  const ia = useIndexInteraction({
    n: geo ? n : 0,
    indexAt: (px) => {
      if (!geo) return null;
      if (n === 1) return 0;
      return clamp(Math.round(((px - geo.ml) / geo.iw) * (n - 1)), 0, n - 1);
    },
    tip,
    anchor: (i) => (geo ? { x: geo.xs[i], y: geo.ys[i] ?? geo.base - geo.ih / 2 } : { x: 0, y: 0 }),
    initial: () => n - 1,
  });

  const staticLayer = useMemo(() => {
    if (!geo) return null;
    const r = width - geo.mr;
    return (
      <>
        <g>
          {geo.ticks.map((t) => (
            <g key={t.v}>
              <line className={t.axis ? 'axis' : 'grid'} x1={geo.ml} x2={r} y1={t.y} y2={t.y} />
              <text className="tick" x={geo.ml - 8} y={t.y + 3.5} textAnchor="end">{t.label}</text>
            </g>
          ))}
        </g>
        {area && geo.area && <path d={geo.area} style={{ fill: color, fillOpacity: 0.1 }} />}
        {geo.line && (
          <path d={geo.line} style={{ fill: 'none', stroke: color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
        )}
        {geo.lone.map((i) => <circle key={i} cx={geo.xs[i]} cy={geo.ys[i]!} r={2.5} style={{ fill: color }} />)}
        <g>
          {geo.labels.map((l) => (
            <text key={l.i} className="xl" x={l.x} y={height - 6} textAnchor={l.anchor}>{l.text}</text>
          ))}
        </g>
        {geo.end && (
          <g>
            <circle cx={geo.end.x} cy={geo.end.y} r={4} className="gd-hover-dot" style={{ fill: color }} />
            <text className="end-label" x={geo.end.x + 10} y={geo.end.y + 4}>{geo.end.value}</text>
            {valueLabel && <text className="gd-end-noun" x={geo.end.x + 10} y={geo.end.nounY}>{valueLabel}</text>}
          </g>
        )}
      </>
    );
  }, [geo, width, height, color, area, valueLabel]);

  const a = ia.active;
  return (
    <div ref={ref} className="gd-chart" style={{ height }}>
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
          {staticLayer}
          {a != null && (
            <g pointerEvents="none">
              <line className="xhair" x1={Math.round(geo.xs[a]) + 0.5} x2={Math.round(geo.xs[a]) + 0.5} y1={MT - 4} y2={geo.base} />
              {geo.ys[a] != null && <circle cx={geo.xs[a]} cy={geo.ys[a]!} r={4} className="gd-hover-dot" style={{ fill: color }} />}
            </g>
          )}
        </svg>
      )}
      {width > 0 && !geo && <div className="gd-empty"><span>{emptyText}</span></div>}
      <div className="gd-sr" aria-live="polite">{ia.live}</div>
      <TipPortal owner={ia.owner} />
    </div>
  );
}
