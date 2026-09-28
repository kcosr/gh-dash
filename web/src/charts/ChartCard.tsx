import { useId, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ChartCardProps } from './index';
import { fmtNum } from './util';

// Table-view toggle state, keyed by card id; persisted so a reader who prefers tables keeps them.
const STORAGE_KEY = 'gh-dash:chart-tables';
let tables: Set<string> = (() => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
})();
const subs = new Set<() => void>();
function setTableView(id: string, on: boolean) {
  tables = new Set(tables);
  if (on) tables.add(id);
  else tables.delete(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...tables]));
  } catch {
    /* storage unavailable: keep in memory */
  }
  subs.forEach((f) => f());
}
function useTableView(id: string): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    () => tables.has(id),
    () => false,
  );
}

const cell = (v: string | number) => (typeof v === 'number' ? fmtNum(v) : v);

export function ChartCard({
  id, title, subtitle, legend, legendShape = 'rect', table, children, wide, loading, actions, className,
}: ChartCardProps) {
  const showTable = useTableView(id);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [frozen, setFrozen] = useState<number | null>(null);
  const titleId = useId();

  const toggle = () => {
    // Keep the card's height when swapping chart <-> table (no layout jump).
    if (!showTable && bodyRef.current) setFrozen(bodyRef.current.offsetHeight);
    setTableView(id, !showTable);
  };
  const tableH = showTable && frozen ? Math.max(frozen, 160) : null;

  return (
    <section
      className={'card gd-card' + (wide ? ' gd-wide' : '') + (loading ? ' gd-loading' : '') + (className ? ` ${className}` : '')}
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
    >
      <div className="card-h">
        <div className="gd-card-titles">
          <h3 id={titleId}>{title}</h3>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        <div className="gd-card-tools">
          {legend && legend.length >= 2 && (
            <div className="legend" role="list" aria-label="Legend">
              {legend.map((s) => (
                <span key={s.key} role="listitem">
                  <i className={legendShape === 'line' ? 'line' : undefined} style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          )}
          {actions}
          <button type="button" className={'tbl-btn' + (showTable ? ' on' : '')} aria-pressed={showTable} onClick={toggle}>
            Table
          </button>
        </div>
      </div>
      <div
        ref={bodyRef}
        className="gd-card-body"
        style={tableH ? ({ minHeight: tableH, '--gd-table-h': `${tableH}px` } as CSSProperties) : undefined}
      >
        {showTable ? (
          <div className="dtable-wrap" tabIndex={0} role="region" aria-label={`${title} (table)`}>
            <table className="dtable">
              <caption className="gd-sr">{title}</caption>
              <thead>
                <tr>
                  {table.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{cell(c)}</th> : <td key={j}>{cell(c)}</td>))}
                  </tr>
                ))}
                {table.rows.length === 0 && (
                  <tr>
                    <td colSpan={table.columns.length} className="gd-norows">No rows</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
