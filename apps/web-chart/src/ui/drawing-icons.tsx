// Icons for the drawing panel (UI-01): simple 20×20 strokes of our own, in
// the current text colour.

import type { ReactElement } from 'react';

const dot = (x: number, y: number) => <circle cx={x} cy={y} r={1.6} fill="currentColor" stroke="none" />;

const ICONS: Readonly<Record<string, ReactElement>> = {
  segment: (
    <>
      <path d="M4 15 16 5" />
      {dot(4, 15)}
      {dot(16, 5)}
    </>
  ),
  rayLine: (
    <>
      <path d="M4 15 18 3.5" />
      {dot(4, 15)}
      {dot(10, 10)}
    </>
  ),
  straightLine: (
    <>
      <path d="M2 16.5 18 3.5" />
      {dot(7, 12.4)}
      {dot(13, 7.6)}
    </>
  ),
  horizontalStraightLine: (
    <>
      <path d="M2 10h16" />
      {dot(10, 10)}
    </>
  ),
  horizontalRayLine: (
    <>
      <path d="M5 10h13" />
      {dot(5, 10)}
    </>
  ),
  verticalStraightLine: (
    <>
      <path d="M10 2v16" />
      {dot(10, 10)}
    </>
  ),
  priceLine: (
    <>
      <path d="M3 12h9" />
      <rect x={12} y={9} width={6} height={6} rx={1} />
      {dot(3, 12)}
    </>
  ),
  parallelStraightLine: (
    <>
      <path d="M2 12 14 4M6 16l12-8" />
      {dot(5, 10)}
      {dot(15, 9.3)}
    </>
  ),
  fibonacciLine: (
    <>
      <path d="M3 4h14M3 8h14M3 11h14M3 16h14" />
      <path d="M5 16 15 4" strokeDasharray="2 2" />
    </>
  ),
  aiaRectangle: <rect x={3.5} y={5} width={13} height={10} rx={1} />,
  aiaCircle: <circle cx={10} cy={10} r={6.5} />,
  aiaTriangle: <path d="M10 3.5 17 16H3z" />,
  aiaNote: <path d="M4 5h12M10 5v11M7.5 16h5" />,
  magnet: <path d="M5 3v7a5 5 0 0 0 10 0V3M5 6.5h3M12 6.5h3M8 3v7a2 2 0 0 0 4 0V3" />,
  lock: (
    <>
      <rect x={4.5} y={9} width={11} height={8} rx={1.5} />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </>
  ),
  hide: (
    <>
      <path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z" />
      <circle cx={10} cy={10} r={2.2} />
      <path d="M3.5 3.5l13 13" />
    </>
  ),
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6M8.7 9v4.5M11.3 9v4.5" />,
};

export function DrawingIcon({ name }: { readonly name: string }) {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
