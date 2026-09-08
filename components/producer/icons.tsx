// The partner portal's 16px stroked icons, inheriting currentColor. Kept
// local because components/icons.tsx belongs to another owner; if a shared
// set lands, these four can move there unchanged.

type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
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
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5l3.2 3.2L13 5" />
    </Svg>
  );
}

export function IconArrowLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 8H3M7 4L3 8l4 4" />
    </Svg>
  );
}

export function IconLogout(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10 11l3-3-3-3M13 8H6.5" />
    </Svg>
  );
}

export function IconFilm(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3" />
    </Svg>
  );
}

export function IconLibrary(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M5.5 2.5v11M8.5 6h3M8.5 9h3" />
    </Svg>
  );
}

export function IconMarket(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 13.5h11M4 11V7.5M7.3 11V4.5M10.6 11V6M13 11V3" />
    </Svg>
  );
}

export function IconCompass(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M10.5 5.5l-1.6 4-4 1.6 1.6-4z" />
    </Svg>
  );
}

export function IconSources(p: IconProps) {
  return (
    <Svg {...p}>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function IconPromote(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 9V6.5l8-3v8l-8-2.5zM10.5 6h1.2a1.8 1.8 0 0 1 0 3.5h-1.2M4 9.5l1 3h2" />
    </Svg>
  );
}

export function IconScript(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 2.5h6l2 2v9H4zM10 2.5v2h2M6 7h4M6 9.5h4M6 12h2.5" />
    </Svg>
  );
}

export function IconCaptions(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.5" y="3" width="13" height="10" rx="2" />
      <path d="M4 7h3M9 7h3M4 10h4M10 10h2" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Svg>
  );
}

export function IconHistory(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.1 5.2A5.5 5.5 0 1 1 2.7 10M3.1 5.2V2.5M3.1 5.2h2.7M8 5v3l2 1.2" />
    </Svg>
  );
}
