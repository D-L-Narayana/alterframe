/** Original 20 px line icons (stroke 1.75). All decorative: parents supply the accessible name. */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (props: P): P => ({
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, ...props,
});

export const CloseIcon = (p: P) => (<svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>);
export const SettingsIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const HelpIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></svg>
);
export const RecordIcon = (p: P) => (<svg {...base(p)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /></svg>);
export const StopIcon = (p: P) => (<svg {...base(p)}><circle cx="12" cy="12" r="9" /><rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" /></svg>);
export const CameraIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
export const SwitchCameraIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><path d="M9.5 13a2.5 2.5 0 0 1 4.6-1.4M14.5 13a2.5 2.5 0 0 1-4.6 1.4" /><path d="M14 10.5v1.5h-1.5M10 15.5V14h1.5" /></svg>
);
export const MirrorIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 3v18" strokeDasharray="2 3" /><path d="M9 7L4 12l5 5V7zM15 7l5 5-5 5V7z" /></svg>
);
export const PlayIcon = (p: P) => (<svg {...base(p)}><path d="M7 5v14l11-7z" fill="currentColor" /></svg>);
export const HudIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /><path d="M9 12h6" /></svg>
);
export const FileIcon = (p: P) => (
  <svg {...base(p)}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M10 11l5 3-5 3z" fill="currentColor" stroke="none" /></svg>
);
export const FpsIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 18l4-7 4 4 4-9 4 6" /></svg>
);
export const WindowHandsIcon = (p: P) => (
  // Original mark: two L-shaped hands framing a window.
  <svg {...base(p)}>
    <path d="M3 6v12M3 6h6M21 18V6M21 18h-6" />
    <rect x="8" y="9" width="8" height="6" rx="1" fill="currentColor" fillOpacity=".25" />
  </svg>
);
export const RetryIcon = (p: P) => (
  <svg {...base(p)}><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></svg>
);
export const MoreIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.6" fill="currentColor" /><circle cx="15" cy="12" r="1.6" fill="currentColor" /><circle cx="8" cy="17" r="1.6" fill="currentColor" /></svg>
);
