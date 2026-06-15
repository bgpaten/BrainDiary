// Inline SVG icon set for the node-canvas UI.
// One stroke-based component, sized via `size` (default 18). No external deps.

export type IconName =
  | 'logo'
  | 'chevron-left'
  | 'chevron-right'
  | 'graph'
  | 'review'
  | 'chat'
  | 'timeline'
  | 'digest'
  | 'evaluation'
  | 'calibration'
  | 'similarity'
  | 'drift'
  | 'reflection'
  | 'chat-samples'
  | 'conflicts'
  | 'routine'
  | 'backup'
  | 'self-clone'
  | 'runtime'
  | 'memory'
  | 'release'
  | 'settings'
  | 'expand'
  | 'refresh'
  | 'process'
  | 'logout'
  | 'user'
  | 'send'
  | 'sparkles'
  | 'import'
  | 'sync'
  | 'index'
  | 'duplicate'
  | 'panel'
  | 'close'
  | 'routine-daily'
  | 'routine-three-day'
  | 'routine-weekly'
  | 'spinner'

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

// Each entry returns the inner SVG content for a 24x24 viewBox.
const PATHS: Record<IconName, JSX.Element> = {
  logo: (
    <>
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  'chevron-left': <path d="M15 5l-7 7 7 7" />,
  'chevron-right': <path d="M9 5l7 7-7 7" />,
  graph: (
    <>
      <circle cx="6" cy="7" r="2.4" />
      <circle cx="18" cy="7" r="2.4" />
      <circle cx="12" cy="17" r="2.4" />
      <path d="M7.6 8.6l3 6.2M16.4 8.6l-3 6.2M8.4 7h7.2" />
    </>
  ),
  review: (
    <>
      <path d="M9 11l2 2 4-4" />
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
    </>
  ),
  chat: (
    <path d="M4 5.5h16v10H9l-4 3.5v-3.5H4z" strokeLinejoin="round" />
  ),
  timeline: (
    <>
      <path d="M5 4v16" />
      <circle cx="5" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="5" cy="15" r="1.6" fill="currentColor" stroke="none" />
      <path d="M9 8h10M9 15h7" />
    </>
  ),
  digest: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </>
  ),
  evaluation: (
    <>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
    </>
  ),
  calibration: (
    <>
      <circle cx="8" cy="8" r="3" />
      <circle cx="16" cy="16" r="3" />
      <path d="M5 16h6M13 8h6" />
    </>
  ),
  similarity: (
    <>
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </>
  ),
  drift: (
    <>
      <path d="M12 3l9 16H3z" strokeLinejoin="round" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  reflection: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </>
  ),
  'chat-samples': (
    <>
      <path d="M4 5.5h11v7H8l-4 3v-3z" strokeLinejoin="round" />
      <path d="M11 14h9v5h-3l-2 2v-2h-4z" strokeLinejoin="round" />
    </>
  ),
  conflicts: (
    <>
      <path d="M7 4l4 8-4 8M17 4l-4 8 4 8" />
    </>
  ),
  routine: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v3h-3" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  'self-clone': (
    <>
      <rect x="4" y="4" width="11" height="11" rx="2" />
      <rect x="9" y="9" width="11" height="11" rx="2" />
    </>
  ),
  runtime: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  memory: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
  release: (
    <>
      <path d="M14 3l-1 6h5l-9 12 1-7H5z" strokeLinejoin="round" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  expand: (
    <>
      <path d="M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-.7 4" />
      <path d="M20 4v5h-5" />
    </>
  ),
  process: <path d="M7 4l13 8-13 8z" strokeLinejoin="round" />,
  logout: (
    <>
      <path d="M15 5H6v14h9M10 12h10M17 9l3 3-3 3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
    </>
  ),
  send: <path d="M5 12l15-7-6 16-3-7z" strokeLinejoin="round" />,
  sparkles: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" strokeLinejoin="round" />
      <path d="M18 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" strokeLinejoin="round" />
    </>
  ),
  import: (
    <>
      <path d="M12 3v12M8 11l4 4 4-4M5 20h14" />
    </>
  ),
  sync: (
    <>
      <path d="M4 9a8 8 0 0 1 13-3l3 3M20 15a8 8 0 0 1-13 3l-3-3" />
      <path d="M17 6h3V3M7 18H4v3" />
    </>
  ),
  index: (
    <>
      <path d="M5 5h14M5 10h14M5 15h9M5 20h9" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V4h12" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  // Daily: calendar with a check mark
  'routine-daily': (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
      <path d="M9 14.5l2 2 3.5-3.5" />
    </>
  ),
  // 3-Day: cycle/refresh arrows with a numeral 3
  'routine-three-day': (
    <>
      <path d="M19 11a7 7 0 0 0-12-4L4 9.5" />
      <path d="M5 13a7 7 0 0 0 12 4l3-2.5" />
      <path d="M4 5v4.5h4.5M20 19v-4.5h-4.5" />
      <path d="M10.6 11.1c.5-.6 1.6-.6 2.1 0 .4.5.3 1.1-.3 1.5.7.3 1 1 .6 1.7-.5.7-1.7.7-2.3.1" strokeWidth="1.3" />
    </>
  ),
  // Weekly: calendar with week rows
  'routine-weekly': (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
      <path d="M7 13h4M7 16.5h7" />
    </>
  ),
  spinner: (
    <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
  ),
}

export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
