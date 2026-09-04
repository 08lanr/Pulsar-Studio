// The one 16px stroked icon set (globals.css "ICONS"): every glyph is a
// viewBox 0 0 16 16 outline in currentColor at 1.5px, so an icon sits in a
// .side-link, a .btn, an .icon-btn or a .pill without its own colour or
// size rules. No emoji, no dingbats. Other agents import from here rather
// than drawing their own so the set stays one hand.

import type { SVGProps } from "react";

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">;

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
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
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Projects: a stack of two cards. */
export function IconProjects(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="4.5" width="12" height="9.5" rx="1.5" />
      <path d="M4.5 4.5V3.2A1.2 1.2 0 0 1 5.7 2h4.6a1.2 1.2 0 0 1 1.2 1.2v1.3" />
    </Svg>
  );
}

/** Producers: two people. */
export function IconProducers(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="6" cy="5.5" r="2.4" />
      <path d="M1.8 13.5c0-2.5 1.9-4.2 4.2-4.2s4.2 1.7 4.2 4.2" />
      <path d="M10.6 3.4a2.4 2.4 0 0 1 0 4.2M11.4 9.6c1.7.4 2.8 1.9 2.8 3.9" />
    </Svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 2.8v10.4L13 8 4.5 2.8Z" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.8 8.4 6.3 12 13.2 4.6" />
    </Svg>
  );
}

export function IconEdit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 13.5h3l7.6-7.6a1.6 1.6 0 0 0-2.3-2.3L3.2 11.2l-.7 2.3Z" />
      <path d="M9.6 4.9l2.3 2.3" />
    </Svg>
  );
}

/** AI actions: a four-point sparkle with a small companion. */
export function IconSparkle(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 2.5c.4 2.7 1.6 3.9 4.3 4.3-2.7.4-3.9 1.6-4.3 4.3-.4-2.7-1.6-3.9-4.3-4.3C5.4 6.4 6.6 5.2 7 2.5Z" />
      <path d="M12.3 9.8c.2 1.3.7 1.8 2 2-1.3.2-1.8.7-2 2-.2-1.3-.7-1.8-2-2 1.3-.2 1.8-.7 2-2Z" />
    </Svg>
  );
}

export function IconDownload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5v8M4.8 7.4 8 10.6l3.2-3.2" />
      <path d="M2.5 11v1.3a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2V11" />
    </Svg>
  );
}

export function IconUpload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 10.5v-8M4.8 5.6 8 2.4l3.2 3.2" />
      <path d="M2.5 11v1.3a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2V11" />
    </Svg>
  );
}

/** Chevron; `dir` turns it (right by default). */
export function IconChevron({ dir = "right", ...p }: IconProps & { dir?: "up" | "down" | "left" | "right" }) {
  const rotate = { right: 0, down: 90, left: 180, up: 270 }[dir];
  return (
    <Svg {...p} style={{ transform: rotate ? `rotate(${rotate}deg)` : undefined, ...p.style }}>
      <path d="M6 3.5 10.5 8 6 12.5" />
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
      <path d="M8 2.3 14.2 13H1.8L8 2.3Z" />
      <path d="M8 6.6v3M8 11.4v.1" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.2 8A5.2 5.2 0 0 1 3.6 10.7" />
      <path d="M2.8 8A5.2 5.2 0 0 1 12.4 5.3" />
      <path d="M12.6 2.4v3h-3M3.4 13.6v-3h3" />
    </Svg>
  );
}

export function IconFilm(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M5 2.5v11M11 2.5v11M2 5.5h3M2 8h3M2 10.5h3M11 5.5h3M11 8h3M11 10.5h3" />
    </Svg>
  );
}

/** A script or subtitle file: lines of text. */
export function IconText(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4h11M2.5 7h11M2.5 10h7M2.5 13h4" />
    </Svg>
  );
}

export function IconMenu(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Svg>
  );
}

export function IconLogout(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 2.5H3.7a1.2 1.2 0 0 0-1.2 1.2v8.6a1.2 1.2 0 0 0 1.2 1.2h2.8" />
      <path d="M10 4.8 13.2 8 10 11.2M13 8H6" />
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

export function IconX(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

/** Currency: the API-cost tile. */
export function IconCoin(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.6v6.8M10 6.3c-.4-.6-1.1-.9-2-.9-1.2 0-2 .6-2 1.3 0 1.8 4 .8 4 2.6 0 .8-.9 1.3-2 1.3-1 0-1.7-.4-2.1-1" />
    </Svg>
  );
}
