import { useMemo } from 'react';
import type { SparklineProps, StatTileProps } from './index';
import { useElementWidth, useIndexInteraction } from './hooks';
import { TipPortal } from './tooltip';
import { colPath, fmtNum } from './util';

/**
 * Tiny column trend: de-emphasis columns, the last (current) one in the accent. Zero slots keep a
 * 1 px stub so the cadence stays readable. Fixed size (pass `width`/`height`).
 */
export function Sparkline({
  values, titles, unit, width = 120, height = 28, ariaLabel, focusable = true, formatValue = fmtNum,
}: SparklineProps) {
  const n = values.length;
  const geo = useMemo(() => {
    if (!n) return null;
    const max = Math.max(0, ...values.filter(Number.isFinite));
    const slot = width / n;
    // Gap between columns: 3 px normally, down to 1.5 px when the sparkline is squeezed.
    const gap = Math.min(3, Math.max(1.5, slot * 0.3));
    const bw = Math.max(1, Math.min(10, slot - gap, slot * 0.75));
    const ih = height - 1;
    return {
      slot,
      cols: values.map((v, i) => {
        const x = i * slot + (slot - bw) / 2;
        const ok = Number.isFinite(v) && v > 0 && max > 0;
        const bh = ok ? Math.max(2, (v / max) * ih) : 1;
        return { x, top: height - bh, d: colPath(x, height - bh, bw, bh, ok ? 2 : 0), zero: !ok };
      }),
    };
  }, [values, width, height, n]);

  const ia = useIndexInteraction({
    n,
    indexAt: (px) => (geo ? Math.max(0, Math.min(n - 1, Math.floor(px / geo.slot))) : null),
    tip: (i) => ({
      title: titles?.[i],
      rows: [{ color: i === n - 1 ? 'var(--wb-accent)' : 'var(--wb-deemph)', value: formatValue(values[i]), label: unit }],
    }),
    anchor: (i) => (geo ? { x: geo.slot * (i + 0.5), y: geo.cols[i].top } : { x: 0, y: 0 }),
    initial: () => n - 1,
  });

  const a = ia.active;
  const label = ariaLabel ?? `${unit} trend${n ? `, latest ${formatValue(values[n - 1])}` : ''}`;
  const fill = (i: number) =>
    geo!.cols[i].zero ? 'var(--wb-grid)' : i === n - 1 ? 'var(--wb-accent)' : a === i ? 'var(--wb-muted)' : 'var(--wb-deemph)';
  return (
    <span className="gd-spark" style={{ width, height }}>
      <svg
        ref={ia.svgRef}
        className="chart"
        width={width}
        height={height}
        style={{ width, height }}
        role="img"
        aria-label={label}
        tabIndex={focusable && n ? 0 : undefined}
        {...ia.handlers}
      >
        {geo?.cols.map((c, i) => (
          <path
            key={i}
            d={c.d}
            className={a === i && i === n - 1 && !c.zero ? 'gd-lift' : undefined}
            style={{ fill: fill(i) }}
          />
        ))}
      </svg>
      <span className="gd-sr" aria-live="polite">{ia.live}</span>
      <TipPortal owner={ia.owner} />
    </span>
  );
}

const ARROWS = { up: '▲', down: '▼', flat: '→' } as const;
const SPOKEN = { up: 'up', down: 'down', flat: 'unchanged' } as const;

/** Sparkline width inside a tile: up to this, shrinking with the tile down to TILE_SPARK_MIN. */
const TILE_SPARK_MAX = 110;
const TILE_SPARK_MIN = 44;

/**
 * KPI tile. The sparkline box is a flex item (basis 110 px, min 44 px) measured with a
 * ResizeObserver, so the chart is drawn at whatever width the tile leaves it; the delta's
 * "vs prior …" part wraps under the number before the sparkline has to shrink much.
 */
export function StatTile({ label, value, unit, delta, spark }: StatTileProps) {
  const tone = delta && delta.good !== null ? (delta.good ? ' good' : ' bad') : '';
  const [boxRef, boxW] = useElementWidth<HTMLSpanElement>();
  const sparkW = spark ? Math.max(TILE_SPARK_MIN, Math.min(spark.width ?? TILE_SPARK_MAX, boxW)) : 0;
  return (
    <div className="tile gd-tile">
      <span className="lbl">{label}</span>
      <div className="row">
        <div className="gd-tile-main">
          <div className="val">
            {value}
            {unit && <small>{unit}</small>}
          </div>
          {delta && (
            <span className={'delta' + tone}>
              <b>
                <span aria-hidden="true">{ARROWS[delta.direction]} </span>
                <span className="gd-sr">{SPOKEN[delta.direction]} </span>
                {delta.text}
              </b>
              {delta.vs && <> <span className="vs">vs {delta.vs}</span></>}
            </span>
          )}
        </div>
        {spark && (
          <span ref={boxRef} className="gd-tile-spark">
            {boxW > 0 && <Sparkline height={34} {...spark} width={sparkW} />}
          </span>
        )}
      </div>
    </div>
  );
}
