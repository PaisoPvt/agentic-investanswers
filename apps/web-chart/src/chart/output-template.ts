// The KLineChart indicator template that draws server output (M3-05); the
// mapping itself is indicator-overlay.ts. Kept apart because importing
// KLineChart needs a browser.

import type { Indicator, KLineData } from 'klinecharts';
import { registerIndicator } from 'klinecharts';

import type { OverlayRow } from './indicator-overlay.js';
import { OUTPUT_TEMPLATE, overlayMarkers, overlayPoints, overlayRows } from './indicator-overlay.js';

const LONG = '#16a34a';
const SHORT = '#dc2626';

let registered = false;

/** Registers the template once per page. */
export function registerOutputTemplate(): void {
  if (registered) return;
  registered = true;
  registerIndicator<OverlayRow, number, number>({
    name: OUTPUT_TEMPLATE,
    series: 'price',
    figures: [],
    calc: (dataList: KLineData[], indicator: Indicator<OverlayRow, number, number>) => overlayRows(dataList, overlayPoints.get(indicator.id)),
    // KLineChart's default recalculates only for new calcParams or figures; a
    // new revision (extendData) means new points, so it recalculates too.
    shouldUpdate: (prev, current) => ({ calc: prev.extendData !== current.extendData, draw: true }),
    draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
      const { from, to } = chart.getVisibleRange();
      const bars = chart.getDataList().slice(Math.max(0, from), to);
      for (const { timestamp, marker } of overlayMarkers(bars, overlayPoints.get(indicator.id))) {
        const x = xAxis.convertTimestampToPixel(timestamp);
        const below = marker.side === 'below';
        const tip = yAxis.convertToPixel(marker.price) + (below ? 4 : -4);
        const base = tip + (below ? 10 : -10);
        ctx.fillStyle = below ? LONG : SHORT;
        ctx.beginPath();
        ctx.moveTo(x, tip);
        ctx.lineTo(x - 5, base);
        ctx.lineTo(x + 5, base);
        ctx.closePath();
        ctx.fill();
        if (marker.text !== undefined) {
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = below ? 'top' : 'bottom';
          ctx.fillText(marker.text, x, base + (below ? 2 : -2));
        }
      }
      // false: KLineChart still draws the line figures.
      return false;
    },
  });
}
