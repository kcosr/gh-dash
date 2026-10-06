import { useMemo } from 'react';
import type { CalendarHeatmapProps } from './index';
import { useElementWidth, useFontsVersion, useIndexInteraction, type StepFn } from './hooks';
import { TipPortal } from './tooltip';
import { MONTHS, WEEKDAYS, fmtNum, formatLongDate, parseDay, textWidth } from './util';

const TOP = 18; // month label band
const MAX_CELL = 22;
const SUMMARY_W = 168; // room needed to show the side summary

interface Geo {
  lw: number;
  cell: number;
  gap: number;
  wd0: number;
  nW: number;
  gridW: number;
  height: number;
  levels: number[];
  thresholds: number[];
  months: { x: number; text: string }[];
  weekdays: { y: number; text: string }[];
  withYear: boolean;
  summary: boolean;
}

/** Level 0 = zero; 1..5 scale linearly up to the 95th percentile of non-zero days (outliers cap at 5). */
function levelScale(counts: number[]) {
  const nz = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const top = nz.length ? nz[Math.min(nz.length - 1, Math.ceil(nz.length * 0.95) - 1)] : 1;
  const scaleMax = Math.max(1, top);
  const level = (c: number) => (c <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil((c / scaleMax) * 5))));
  // Upper bound (inclusive) of each level, for the legend.
  const thresholds = [0, 1, 2, 3, 4, 5].map((l) => (l === 0 ? 0 : Math.floor((l / 5) * scaleMax)));
  return { level, thresholds };
}

function layout(days: CalendarHeatmapProps['days'], width: number, wantSummary: boolean): Geo {
  const n = days.length;
  const first = parseDay(days[0].date);
  const last = parseDay(days[n - 1].date);
  const wd0 = first.wd;
  const nW = Math.floor((n - 1 + wd0) / 7) + 1;
  const lw = Math.ceil(textWidth('Mon', 11)) + 8;
  let gap = 2;
  let cell = Math.min(MAX_CELL, Math.floor((width - lw) / nW) - gap);
  if (cell < 6) {
    gap = 1;
    cell = Math.max(2, Math.floor((width - lw) / nW) - gap);
  }
  const pitch = cell + gap;
  const gridW = nW * pitch - gap;
  const summary = wantSummary && width - lw - gridW >= SUMMARY_W + 24;
  const { level, thresholds } = levelScale(days.map((d) => d.count));

  // Month labels at the first column whose Monday falls in the month; drop collisions (later wins).
  const months: { x: number; text: string; col: number }[] = [];
  const colOf = (i: number) => Math.floor((i + wd0) / 7);
  if (first.d <= 21) months.push({ col: 0, x: lw, text: MONTHS[first.m - 1] });
  for (let i = 1; i < n; i++) {
    const p = parseDay(days[i].date);
    if (p.d !== 1) continue;
    const col = Math.ceil((i + wd0) / 7);
    if (col >= nW) continue;
    months.push({ col, x: lw + col * pitch, text: p.m === 1 ? `${MONTHS[0]} ${p.y}` : MONTHS[p.m - 1] });
  }
  const placed: typeof months = [];
  for (const m of months) {
    const prev = placed[placed.length - 1];
    if (prev && prev.x + textWidth(prev.text, 11) + 6 > m.x) placed.pop();
    placed.push(m);
  }
  if (!placed.length && n) placed.push({ col: colOf(0), x: lw, text: MONTHS[first.m - 1] });

  const rowsToLabel = 2 * pitch >= 12 ? [0, 2, 4, 6] : [0, 3, 6];
  return {
    lw, cell, gap, wd0, nW, gridW,
    height: TOP + 7 * pitch - gap,
    levels: days.map((d) => level(d.count)),
    thresholds,
    months: placed,
    weekdays: rowsToLabel.map((r) => ({ y: TOP + r * pitch + cell / 2 + 3.5, text: WEEKDAYS[r] })),
    withYear: first.y !== last.y,
    summary,
  };
}

const heatStep: StepFn = (key, i, n) => {
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, i - 7);
    case 'ArrowRight':
      return Math.min(n - 1, i + 7);
    case 'ArrowUp':
      return Math.max(0, i - 1);
    case 'ArrowDown':
      return Math.min(n - 1, i + 1);
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return null;
  }
};

export function CalendarHeatmap({
  days, unit, ariaLabel, onDayClick, showSummary = true, emptyText = 'No data in this range',
}: CalendarHeatmapProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fontsV = useFontsVersion();
  const n = days.length;
  const geo = useMemo(
    () => (width > 0 && n > 0 ? layout(days, width, showSummary) : null),
    [days, width, showSummary, fontsV], // fontsV: re-measure once web fonts load
  );
  const pos = (i: number) => {
    const g = geo!;
    const k = i + g.wd0;
    return { x: g.lw + Math.floor(k / 7) * (g.cell + g.gap), y: TOP + (k % 7) * (g.cell + g.gap) };
  };

  const ia = useIndexInteraction({
    n: geo ? n : 0,
    indexAt: (px, py) => {
      if (!geo) return null;
      const pitch = geo.cell + geo.gap;
      const col = Math.floor((px - geo.lw + geo.gap / 2) / pitch);
      const row = Math.floor((py - TOP + geo.gap / 2) / pitch);
      if (col < 0 || col >= geo.nW || row < 0 || row > 6) return null;
      const i = col * 7 + row - geo.wd0;
      return i >= 0 && i < n ? i : null;
    },
    tip: (i) => {
      const lvl = geo?.levels[i] ?? 0;
      return {
        title: formatLongDate(days[i].date, geo?.withYear),
        rows: [{ color: `var(--wb-seq-${Math.max(1, lvl)})`, value: fmtNum(days[i].count), label: unit }],
      };
    },
    anchor: (i) => {
      const p = pos(i);
      return { x: p.x + geo!.cell / 2, y: p.y };
    },
    onActivate: onDayClick ? (i) => onDayClick(days[i].date) : null,
    initial: () => n - 1,
    step: heatStep,
  });

  const cells = useMemo(() => {
    if (!geo) return null;
    const rx = Math.min(3, Math.max(1, geo.cell * 0.2));
    return (
      <g>
        {geo.weekdays.map((w) => (
          <text key={w.text} className="tick" x={0} y={w.y}>{w.text}</text>
        ))}
        {geo.months.map((m) => (
          <text key={`${m.x}-${m.text}`} className="tick" x={m.x} y={11}>{m.text}</text>
        ))}
        {days.map((d, i) => {
          const k = i + geo.wd0;
          return (
            <rect
              key={d.date}
              x={geo.lw + Math.floor(k / 7) * (geo.cell + geo.gap)}
              y={TOP + (k % 7) * (geo.cell + geo.gap)}
              width={geo.cell}
              height={geo.cell}
              rx={rx}
              style={{ fill: `var(--wb-seq-${geo.levels[i]})` }}
            />
          );
        })}
      </g>
    );
  }, [geo, days]);

  const summary = useMemo(() => {
    if (!geo?.summary) return null;
    let total = 0;
    let active = 0;
    let best = 0;
    days.forEach((d, i) => {
      total += d.count;
      if (d.count > 0) active++;
      if (d.count > days[best].count) best = i;
    });
    return (
      <div className="gd-heat-sum">
        <div>
          <span className="k">Total</span>
          <span className="v">{fmtNum(total)}<small>{unit}</small></span>
        </div>
        <div>
          <span className="k">Active days</span>
          <span className="v">{fmtNum(active)}<small>of {fmtNum(n)}</small></span>
        </div>
        {total > 0 && (
          <div>
            <span className="k">Busiest day</span>
            <span className="v">{formatLongDate(days[best].date, geo.withYear)}</span>
            <span className="n">{fmtNum(days[best].count)} {unit}</span>
          </div>
        )}
      </div>
    );
  }, [geo, days, unit, n]);

  const a = ia.active;
  const svgW = geo ? geo.lw + geo.gridW + 2 : 0;
  const ringPos = a != null && geo ? pos(a) : null;
  const t = geo?.thresholds;
  const legendTitle = (l: number) => {
    if (!t) return '';
    if (l === 0) return `0 ${unit}`;
    const lo = t[l - 1] + 1;
    const hi = t[l];
    if (l === 5) return `${fmtNum(lo)}+ ${unit}`;
    if (lo > hi) return '';
    return lo === hi ? `${fmtNum(lo)} ${unit}` : `${fmtNum(lo)}–${fmtNum(hi)} ${unit}`;
  };

  return (
    <div ref={ref} className="gd-chart">
      {geo && (
        <div className="gd-heat">
          <div className="gd-chart" style={{ width: Math.max(svgW, 170) }}>
            <svg
              ref={ia.svgRef}
              className="chart"
              width={svgW}
              height={geo.height + 1}
              style={{ width: svgW, height: geo.height + 1, cursor: onDayClick && ia.hover != null ? 'pointer' : undefined }}
              role="img"
              aria-label={ariaLabel}
              tabIndex={0}
              {...ia.handlers}
            >
              {cells}
              {ringPos && (
                <rect
                  className="gd-cell-ring"
                  x={ringPos.x - 0.25}
                  y={ringPos.y - 0.25}
                  width={geo.cell + 0.5}
                  height={geo.cell + 0.5}
                  rx={Math.min(3, Math.max(1, geo.cell * 0.2))}
                />
              )}
            </svg>
            <div className="heat-legend" style={{ width: Math.max(svgW, 170) }}>
              Less
              {[0, 1, 2, 3, 4, 5].map((l) => (
                <i key={l} style={{ background: `var(--wb-seq-${l})` }} title={legendTitle(l)} />
              ))}
              More
            </div>
          </div>
          {summary}
        </div>
      )}
      {width > 0 && n === 0 && <div className="gd-empty gd-empty-flow"><span>{emptyText}</span></div>}
      <div className="gd-sr" aria-live="polite">{ia.live}</div>
      <TipPortal owner={ia.owner} />
    </div>
  );
}
