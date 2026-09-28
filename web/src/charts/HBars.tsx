import { useMemo } from 'react';
import type { HBarRow, HBarsProps } from './index';
import { useElementWidth, useFontsVersion, useIndexInteraction, type StepFn } from './hooks';
import { TipPortal, type TipData, type TipRow } from './tooltip';
import { RADIUS, fmtNum, hbarPath, textWidth, truncate } from './util';

const RH = 26; // row pitch (>= 24 px hit target)
const BH = 14; // bar thickness
const PAD_Y = 2;
const LABEL_SIZE = 12.5;
const VALUE_SIZE = 11.5;

interface Row extends HBarRow {
  other?: HBarRow[];
}

interface Geo {
  lw: number;
  height: number;
  rows: { y: number; by: number; bw: number; d: string; text: string; valueText: string }[];
}

function fold(rows: HBarRow[], maxRows: number, otherLabel: string): Row[] {
  const cap = Math.max(1, Math.floor(maxRows));
  // Folding a single row into "Other" hides a name for no gain: only fold 2+.
  if (rows.length <= cap + 1) return rows;
  const rest = rows.slice(cap);
  return [
    ...rows.slice(0, cap),
    { key: '__other__', label: `${otherLabel} (${rest.length})`, value: rest.reduce((t, r) => t + r.value, 0), other: rest },
  ];
}

function layout(rows: Row[], width: number, fmt: (v: number) => string): Geo {
  const natural = Math.max(...rows.map((r) => textWidth(r.label, LABEL_SIZE)));
  const cap = Math.max(72, Math.floor(width * 0.36));
  const labelW = Math.min(Math.ceil(natural), cap);
  const lw = labelW + 14;
  const valueTexts = rows.map((r) => fmt(r.value));
  const pad = Math.ceil(Math.max(...valueTexts.map((t) => textWidth(t, VALUE_SIZE)))) + 12;
  const max = Math.max(0, ...rows.map((r) => r.value));
  const avail = Math.max(8, width - lw - pad);
  return {
    lw,
    height: PAD_Y * 2 + rows.length * RH,
    rows: rows.map((r, i) => {
      const y = PAD_Y + i * RH;
      const by = y + (RH - BH) / 2;
      const bw = max > 0 && r.value > 0 ? Math.max(2, (r.value / max) * avail) : 0;
      return {
        y, by, bw,
        d: bw > 0 ? hbarPath(lw, by, bw, BH, RADIUS) : '',
        text: truncate(r.label, labelW, LABEL_SIZE),
        valueText: valueTexts[i],
      };
    }),
  };
}

const verticalStep: StepFn = (key, i, n) => {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowLeft':
      return Math.max(0, i - 1);
    case 'ArrowDown':
    case 'ArrowRight':
      return Math.min(n - 1, i + 1);
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return null;
  }
};

export function HBars({
  rows: input, unit, ariaLabel, color = 'var(--s1)', maxRows = 8, formatValue = fmtNum,
  emptyText = 'No activity in this range', otherLabel = 'Other',
}: HBarsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fontsV = useFontsVersion();
  const rows = useMemo(() => fold(input, maxRows, otherLabel), [input, maxRows, otherLabel]);
  const n = rows.length;
  const geo = useMemo(
    () => (width > 0 && n > 0 ? layout(rows, width, formatValue) : null),
    [rows, width, formatValue, fontsV], // fontsV: re-measure once web fonts load
  );
  const barColor = (r: Row) => (r.other ? 'var(--deemph)' : color);

  const tip = (i: number): TipData => {
    const r = rows[i];
    const out: TipRow[] = [{ color: barColor(r), value: formatValue(r.value), label: unit }];
    if (r.other) {
      const show = r.other.slice(0, 6);
      for (const o of show) out.push({ value: formatValue(o.value), label: o.label });
      if (r.other.length > show.length) out.push({ value: '', label: `+ ${r.other.length - show.length} more` });
    }
    for (const b of r.breakdown ?? []) out.push({ color: b.color, value: formatValue(b.value), label: b.label });
    return { title: r.label, rows: out };
  };

  const ia = useIndexInteraction({
    n: geo ? n : 0,
    indexAt: (_px, py) => {
      const i = Math.floor((py - PAD_Y) / RH);
      return i >= 0 && i < n ? i : null;
    },
    tip,
    anchor: (i) => (geo ? { x: geo.lw + geo.rows[i].bw, y: geo.rows[i].by } : { x: 0, y: 0 }),
    onActivate: (i) => rows[i]?.onClick?.(),
    initial: () => 0,
    step: verticalStep,
  });

  const bars = useMemo(
    () =>
      geo && (
        <g>
          <line className="axis" x1={geo.lw + 0.5} x2={geo.lw + 0.5} y1={0} y2={geo.height} />
          {geo.rows.map((g, i) => {
            const r = rows[i];
            const mid = g.by + BH / 2 + 4;
            return (
              <g key={r.key}>
                <text className={'row-label' + (r.other ? ' other' : '')} x={geo.lw - 10} y={mid} textAnchor="end">{g.text}</text>
                {g.d && <path d={g.d} style={{ fill: barColor(r) }} />}
                <text className="bar-label" x={geo.lw + g.bw + 6} y={mid - 0.5}>{g.valueText}</text>
              </g>
            );
          })}
        </g>
      ),
    [geo, rows, color],
  );

  const a = ia.active;
  const clickable = a != null && !!rows[a]?.onClick;
  return (
    <div ref={ref} className="gd-chart" style={{ height: geo ? geo.height : undefined }}>
      {geo && (
        <svg
          ref={ia.svgRef}
          className="chart"
          width={width}
          height={geo.height}
          style={{ width, height: geo.height, cursor: clickable && ia.hover != null ? 'pointer' : undefined }}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          {...ia.handlers}
        >
          {a != null && (
            <rect className="gd-wash" x={0} y={geo.rows[a].y} width={width} height={RH} rx={6} />
          )}
          {bars}
          {a != null && geo.rows[a].d && (
            <path
              d={geo.rows[a].d}
              pointerEvents="none"
              className={'gd-lift' + (rows[a].other ? ' muted' : '')}
              style={{ fill: barColor(rows[a]) }}
            />
          )}
          {ia.kbd != null && ia.hover == null && (
            <rect className="gd-row-ring" x={0.75} y={geo.rows[ia.kbd].y + 0.75} width={width - 1.5} height={RH - 1.5} rx={6} />
          )}
        </svg>
      )}
      {width > 0 && n === 0 && <div className="gd-empty gd-empty-flow"><span>{emptyText}</span></div>}
      <div className="gd-sr" aria-live="polite">{ia.live}</div>
      <TipPortal owner={ia.owner} />
    </div>
  );
}
