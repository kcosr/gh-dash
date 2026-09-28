/**
 * Chart components — public interface.
 *
 * OWNED BY THE CHARTS AGENT. The web app imports only from this module.
 * The prop interfaces below are the contract; implementations live in sibling
 * files and are re-exported at the bottom. Hand-rolled SVG, no chart library.
 *
 * Color conventions:
 *  - Activity series are fixed by entity, never by rank: commits = --s1, PRs merged = --s2, issues = --s3.
 *  - "You vs others" uses the emphasis form: you = --s1, others = --deemph.
 *  - Single-series charts use --s1. Magnitude (heatmap) uses the --seq-0..5 ramp.
 *  - Text never wears series color.
 */
import type { ReactNode } from 'react';
import './charts.css';

export interface SeriesDef {
  key: string;
  label: string;
  /** Any CSS color; normally a token such as 'var(--s1)'. */
  color: string;
}

export const ACTIVITY_SERIES = {
  commits: { key: 'commits', label: 'Commits', color: 'var(--s1)' },
  prsMerged: { key: 'prsMerged', label: 'PRs merged', color: 'var(--s2)' },
  issues: { key: 'issues', label: 'Issues', color: 'var(--s3)' },
} satisfies Record<string, SeriesDef>;

export const YOU_VS_OTHERS: SeriesDef[] = [
  { key: 'mine', label: 'You', color: 'var(--s1)' },
  { key: 'others', label: 'Others', color: 'var(--deemph)' },
];

export interface ColumnDatum {
  /** X-axis label, e.g. "Sep 21". */
  label: string;
  /** Tooltip heading, e.g. "Week of Sep 21". */
  title: string;
  values: Record<string, number>;
}

export interface StackedColumnsProps {
  data: ColumnDatum[];
  /** Stacking order bottom -> top; also legend order. One series => plain columns. */
  series: SeriesDef[];
  /** Total height including the x-axis band. Default 220. */
  height?: number;
  ariaLabel: string;
  onColumnClick?: (index: number) => void;
  /** Emphasis form: this column stays in color (with its x label pinned); the rest fade. */
  highlightIndex?: number | null;
  /** Tooltip / tick formatter. Default: thousands-comma'd, 1 decimal for fractions. */
  formatValue?: (v: number) => string;
  /** Shown over the plot when there is no data or every value is 0. */
  emptyText?: string;
}

export interface LinePoint {
  label: string;
  title: string;
  /** Pass NaN for "no data" (e.g. a bucket with no merged PRs): the line breaks there. */
  value: number;
  /** Extra tooltip rows, e.g. [{ label: 'new that day', value: '+3' }]. */
  extra?: { label: string; value: string }[];
}

export interface LineChartProps {
  points: LinePoint[];
  /** Tooltip / end-label noun, e.g. "stars". */
  valueLabel: string;
  height?: number;
  ariaLabel: string;
  /** Default false: the y-domain is fitted to the data with nice bounds. */
  zeroBased?: boolean;
  color?: string;
  /** Draw a 10% area wash under the line. Default true. */
  area?: boolean;
  /** Tooltip / tick / end-label formatter, e.g. hours -> "12.5". */
  formatValue?: (v: number) => string;
  emptyText?: string;
}

export interface CalendarHeatmapProps {
  /** Contiguous days 'YYYY-MM-DD', oldest first. */
  days: { date: string; count: number }[];
  /** Tooltip noun, e.g. "commits". */
  unit: string;
  ariaLabel: string;
  onDayClick?: (date: string) => void;
  /** Total / active days / busiest day beside the grid when there is room. Default true. */
  showSummary?: boolean;
  emptyText?: string;
}

export interface HBarRow {
  key: string;
  label: string;
  value: number;
  /** Extra tooltip rows (optional `color` draws a line key, e.g. 'var(--s2)'). */
  breakdown?: { label: string; value: number; color?: string }[];
  onClick?: () => void;
}

export interface HBarsProps {
  rows: HBarRow[];
  unit: string;
  ariaLabel: string;
  color?: string;
  /** Rows beyond this fold into "Other". Default 8. */
  maxRows?: number;
  formatValue?: (v: number) => string;
  emptyText?: string;
  /** Label of the folded row. Default "Other" (rendered as "Other (N)"). */
  otherLabel?: string;
}

export interface SparklineProps {
  values: number[];
  /** Per-value tooltip headings. */
  titles?: string[];
  unit: string;
  /** Default 120 (110 inside a StatTile). */
  width?: number;
  /** Default 28 (34 inside a StatTile). */
  height?: number;
  /** Default "<unit> trend, latest N". */
  ariaLabel?: string;
  /** Tab stop with arrow-key tooltips. Default true; pass false in long lists (e.g. repo rows). */
  focusable?: boolean;
  formatValue?: (v: number) => string;
}

export interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  delta?: { text: string; direction: 'up' | 'down' | 'flat'; good: boolean | null; vs: string } | null;
  spark?: SparklineProps;
}

export interface ChartCardProps {
  /** Stable id (used for the table-view toggle state). */
  id: string;
  title: string;
  subtitle?: string;
  legend?: SeriesDef[];
  legendShape?: 'rect' | 'line';
  /** Accessible table twin of the chart. */
  table: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
  /** Span both columns of the insights grid. */
  wide?: boolean;
  /** Hold the previous render at reduced opacity while refetching. */
  loading?: boolean;
  actions?: ReactNode;
  className?: string;
}

export interface ActivityStripProps {
  /** Contiguous days, oldest first. */
  days: { date: string; count: number; title?: string }[];
  ariaLabel: string;
  selected?: string | null;
  onSelect?: (date: string) => void;
  /** Total height including the date label band. Default 56. */
  height?: number;
  /** Tooltip noun. Default "events". */
  unit?: string;
  emptyText?: string;
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------
export { StackedColumns } from './StackedColumns';
export { LineChart } from './LineChart';
export { CalendarHeatmap } from './CalendarHeatmap';
export { HBars } from './HBars';
export { Sparkline, StatTile } from './Sparkline';
export { ChartCard } from './ChartCard';
export { ActivityStrip } from './ActivityStrip';
/** Date helpers matching the chart labels: "Sep 21" and "Sun, Sep 21". */
export { formatShortDate, formatLongDate, fmtNum as formatNumber } from './util';
