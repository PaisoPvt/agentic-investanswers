// Our drawing templates for KLineChart (UI-01): rectangle, circle, triangle
// and the text note. KLineChart's own overlays cover the other tools.

import type { Coordinate, OverlayFigure, OverlayTemplate } from 'klinecharts';
import { registerOverlay } from 'klinecharts';

import { NOTE_TOOL } from './drawing-tools.js';

/** While a shape is still being placed, the clicks so far are joined by a line. */
function partial(coordinates: Coordinate[]): OverlayFigure[] {
  return coordinates.length > 1 ? [{ type: 'line', attrs: { coordinates } }] : [];
}

const rectangle: OverlayTemplate = {
  name: 'aiaRectangle',
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { polygon: { style: 'stroke_fill', color: 'rgba(37, 99, 235, 0.12)', borderColor: '#2563eb', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (a === undefined || b === undefined) return [];
    return {
      type: 'polygon',
      attrs: { coordinates: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }] },
    };
  },
};

const circle: OverlayTemplate = {
  name: 'aiaCircle',
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { circle: { style: 'stroke_fill', color: 'rgba(37, 99, 235, 0.12)', borderColor: '#2563eb', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => {
    const [centre, edge] = coordinates;
    if (centre === undefined || edge === undefined) return [];
    return { type: 'circle', attrs: { x: centre.x, y: centre.y, r: Math.hypot(edge.x - centre.x, edge.y - centre.y) } };
  },
};

const triangle: OverlayTemplate = {
  name: 'aiaTriangle',
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { polygon: { style: 'stroke_fill', color: 'rgba(37, 99, 235, 0.12)', borderColor: '#2563eb', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => (coordinates.length < 3 ? partial(coordinates) : { type: 'polygon', attrs: { coordinates } }),
};

/** A text note pinned to a bar and price. Its text is the overlay's extendData. */
const note: OverlayTemplate<string> = {
  name: NOTE_TOOL,
  totalStep: 2,
  needDefaultPointFigure: true,
  styles: {
    text: {
      style: 'fill',
      color: '#ffffff',
      size: 12,
      backgroundColor: '#2563eb',
      borderRadius: 3,
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 3,
      paddingBottom: 3,
    },
  },
  createPointFigures: ({ coordinates, overlay }) => {
    const [at] = coordinates;
    if (at === undefined) return [];
    const text = typeof overlay.extendData === 'string' && overlay.extendData !== '' ? overlay.extendData : 'Note';
    return { type: 'text', attrs: { x: at.x, y: at.y, text, align: 'left', baseline: 'bottom' } };
  },
};

let registered = false;

/** Registers our shape and note templates with KLineChart, once per page. */
export function registerDrawingTemplates(): void {
  if (registered) return;
  registered = true;
  registerOverlay(rectangle);
  registerOverlay(circle);
  registerOverlay(triangle);
  registerOverlay(note);
}
