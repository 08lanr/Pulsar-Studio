// The workbench's icon set. The app-wide set lives in components/icons.tsx
// (owned by the admin shell); this file is the one import the workbench
// components use, so a rename or a move there is a one-line change here.
// Until the shared file carries every name, the 16px stroked SVGs are drawn
// locally in the same style: currentColor, 1.5px stroke, round joins.

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 3.2v9.6l8-4.8z" />
    </Svg>
  );
}

export function IconPause(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 3.5v9M11 3.5v9" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5l3.2 3.2L13 5" />
    </Svg>
  );
}

export function IconEdit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.5 2.8l2.7 2.7L5.7 13H3v-2.7z" />
      <path d="M9.2 4.1l2.7 2.7" />
    </Svg>
  );
}

export function IconSparkle(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5l1.3 3.4 3.4 1.3-3.4 1.3L8 11.9 6.7 8.5 3.3 7.2l3.4-1.3z" />
      <path d="M12.8 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" />
    </Svg>
  );
}

export function IconChevron(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </Svg>
  );
}

export function IconMore(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" />
    </Svg>
  );
}

export function IconAlert(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 6.5v3M8 11.5h.01" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 8a5 5 0 0 1-8.7 3.4M3 8a5 5 0 0 1 8.7-3.4" />
      <path d="M11.5 2v2.8h-2.8M4.5 14v-2.8h2.8" />
    </Svg>
  );
}
