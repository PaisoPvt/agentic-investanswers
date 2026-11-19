// The drawing tools offered in the side panel (UI-01, client UI feedback).
// Most are KLineChart's own overlays; the shapes and the text note are small
// templates of ours, registered once. Drawings are the trader's own marks on
// the chart: they never reach the server (saved in the browser, decision
// record T-10) and have nothing to do with indicators. The templates are in
// drawing-templates.ts, apart, so this list loads without a browser.

export type DrawingGroup = 'lines' | 'fibonacci' | 'shapes' | 'notes';

export interface DrawingTool {
  /** The KLineChart overlay name; also what is saved for each drawing. */
  readonly name: string;
  readonly label: string;
  readonly group: DrawingGroup;
  /** How many clicks place it, for the panel's hint. */
  readonly clicks: number;
}

export const NOTE_TOOL = 'aiaNote';

export const DRAWING_TOOLS: readonly DrawingTool[] = [
  { name: 'segment', label: 'Trend line', group: 'lines', clicks: 2 },
  { name: 'rayLine', label: 'Ray', group: 'lines', clicks: 2 },
  { name: 'straightLine', label: 'Extended line', group: 'lines', clicks: 2 },
  { name: 'horizontalStraightLine', label: 'Horizontal line', group: 'lines', clicks: 1 },
  { name: 'horizontalRayLine', label: 'Horizontal ray', group: 'lines', clicks: 2 },
  { name: 'verticalStraightLine', label: 'Vertical line', group: 'lines', clicks: 1 },
  { name: 'priceLine', label: 'Price line', group: 'lines', clicks: 1 },
  { name: 'parallelStraightLine', label: 'Parallel channel', group: 'lines', clicks: 3 },
  { name: 'fibonacciLine', label: 'Fibonacci retracement', group: 'fibonacci', clicks: 2 },
  { name: 'aiaRectangle', label: 'Rectangle', group: 'shapes', clicks: 2 },
  { name: 'aiaCircle', label: 'Circle', group: 'shapes', clicks: 2 },
  { name: 'aiaTriangle', label: 'Triangle', group: 'shapes', clicks: 3 },
  { name: NOTE_TOOL, label: 'Text note', group: 'notes', clicks: 1 },
];

export const GROUP_LABELS: Readonly<Record<DrawingGroup, string>> = {
  lines: 'Lines',
  fibonacci: 'Fibonacci',
  shapes: 'Shapes',
  notes: 'Notes',
};

export function toolByName(name: string): DrawingTool | undefined {
  return DRAWING_TOOLS.find((t) => t.name === name);
}
