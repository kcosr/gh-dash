import type { ReactNode } from 'react';

/** 16px stroke icons, used throughout the dashboard. */
const PATHS = {
  merge: <><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="8.5" r="1.75" /><path d="M4.5 5.25v5.5M4.5 5.5c0 2.2 1.8 3 5.25 3" /></>,
  prOpen: <><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="12.5" r="1.75" /><path d="M4.5 5.25v5.5M11.5 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3L7.5 4.5 9 6" /></>,
  prDraft: <><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="12.5" r="1.75" /><path d="M4.5 5.25v5.5M11.5 3.5v.5M11.5 6.25v.5M11.5 9v.5" /></>,
  prClosed: <><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="12.5" r="1.75" /><path d="M4.5 5.25v5.5M11.5 8.25v2.5M9.75 2.75l3.5 3.5M13.25 2.75l-3.5 3.5" /></>,
  issue: <><circle cx="8" cy="8" r="6.25" /><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" /></>,
  issueClosed: <><circle cx="8" cy="8" r="6.25" /><path d="M5.4 8.2l1.8 1.8 3.4-3.6" /></>,
  commit: <><circle cx="8" cy="8" r="2.5" /><path d="M1.5 8h4M10.5 8h4" /></>,
  tag: <><path d="M2.25 2.25h5.1l6.4 6.4-5.1 5.1-6.4-6.4z" /><circle cx="5.25" cy="5.25" r="1" fill="currentColor" stroke="none" /></>,
  star: <path d="M8 1.75l1.93 3.9 4.3.63-3.11 3.03.73 4.28L8 11.57l-3.85 2.02.73-4.28L1.77 6.28l4.3-.63z" />,
  starFill: <path d="M8 1.75l1.93 3.9 4.3.63-3.11 3.03.73 4.28L8 11.57l-3.85 2.02.73-4.28L1.77 6.28l4.3-.63z" fill="currentColor" />,
  lock: <><rect x="3.25" y="7" width="9.5" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  sync: <><path d="M13.5 8a5.5 5.5 0 0 1-9.9 3.3M2.5 8a5.5 5.5 0 0 1 9.9-3.3" /><path d="M12.75 1.75v3h-3M3.25 14.25v-3h3" /></>,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" /></>,
  moon: <path d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z" />,
  ext: <path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />,
  pin: <><path d="M10.2 1.8l4 4-1.6.6-2.8 2.8.2 3-1.3 1.3-6.2-6.2L3.8 6l3 .2 2.8-2.8z" /><path d="M5 11l-3.25 3.25" /></>,
  chevron: <path d="M4.5 6.25L8 9.75l3.5-3.5" />,
  chevronRight: <path d="M6.25 4.5L9.75 8l-3.5 3.5" />,
  chevronLeft: <path d="M9.75 4.5L6.25 8l3.5 3.5" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  braces: <path d="M5.5 2.5c-1.4 0-2 .6-2 2v1.4c0 1-.5 1.7-1.5 2.1 1 .4 1.5 1.1 1.5 2.1v1.4c0 1.4.6 2 2 2M10.5 2.5c1.4 0 2 .6 2 2v1.4c0 1 .5 1.7 1.5 2.1-1 .4-1.5 1.1-1.5 2.1v1.4c0 1.4-.6 2-2 2" />,
  md: <><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" /><path d="M4 10.25v-4.5l1.75 2 1.75-2v4.5M10.75 5.75v4.5M9.25 8.75l1.5 1.5 1.5-1.5" /></>,
  cal: <><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M5.25 1.5v3M10.75 1.5v3" /></>,
  sliders: <><path d="M2 4.5h6.5M11.5 4.5H14M2 11.5h2M7 11.5h7" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="5.5" cy="11.5" r="1.5" /></>,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  grid: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  layers: <><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></>,
  bookmark: <path d="M4 2.5h8v11l-4-2.75-4 2.75z" />,
  pulse: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  book: <path d="M3 13.25V3.5a1 1 0 0 1 1-1h8.5V12H4.25A1.25 1.25 0 0 0 3 13.25zm0 0a1.25 1.25 0 0 0 1.25 1.25h8.25V12" />,
  chart: <path d="M2 14h12M4.5 11V7.5M8 11V3.5M11.5 11V9" />,
  enter: <path d="M13 3v5a2 2 0 0 1-2 2H3M6 7l-3 3 3 3" />,
  dots: <><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" /></>,
  eyeOff: <><path d="M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.3C2.8 5.2 1.9 6.5 1.5 8c.9 3 3.5 5 6.5 5 1.3 0 2.5-.4 3.6-1M7 3.1c.3 0 .7-.1 1-.1 3 0 5.6 2 6.5 5-.3.9-.7 1.7-1.3 2.4" /></>,
  eye: <><path d="M1.5 8c.9-3 3.5-5 6.5-5s5.6 2 6.5 5c-.9 3-3.5 5-6.5 5s-5.6-2-6.5-5z" /><circle cx="8" cy="8" r="2" /></>,
  key: <><circle cx="5" cy="11" r="2.75" /><path d="M7 9l6.5-6.5M11 5l1.75 1.75M9.5 6.5l1.5 1.5" /></>,
  fork: <><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="11.5" cy="3.5" r="1.75" /><circle cx="8" cy="12.5" r="1.75" /><path d="M4.5 5.25v.75a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-.75M8 8v2.75" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  comment: <path d="M3.5 2.75h9a1.25 1.25 0 0 1 1.25 1.25v6a1.25 1.25 0 0 1-1.25 1.25H7.25L4.5 13.5v-2.25h-1A1.25 1.25 0 0 1 2.25 10V4A1.25 1.25 0 0 1 3.5 2.75z" />,
  trash: <path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.6" />,
  alert: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.5h.01" /></>,
  doc: <><path d="M4 1.75h5.25L12.5 5v9.25H4z" /><path d="M9 1.75V5.25h3.5M6 8.5h4.5M6 11h4.5" /></>,
  diff: <><path d="M4 1.75h5.25L12.5 5v9.25H4z" /><path d="M9 1.75V5.25h3.5M8.25 6.5v3.5M6.5 8.25h3.5M6.5 12h3.5" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
