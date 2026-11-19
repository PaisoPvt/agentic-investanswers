// The drawing panel down the left of the chart (UI-01): the tools by group,
// then the magnet, lock all, hide all and delete all. Choosing a tool starts
// placing it; choosing it again cancels. A hint under the chart says how many
// clicks are left to place it.

import { Fragment, useSyncExternalStore } from 'react';

import type { DrawingLayer } from '../chart/drawing-layer.js';
import type { DrawingGroup } from '../chart/drawing-tools.js';
import { DRAWING_TOOLS, GROUP_LABELS } from '../chart/drawing-tools.js';
import { DrawingIcon } from './drawing-icons.js';

const GROUPS: readonly DrawingGroup[] = ['lines', 'fibonacci', 'shapes', 'notes'];

export function DrawingPanel({ layer }: { readonly layer: DrawingLayer }) {
  const state = useSyncExternalStore(layer.subscribe, layer.get);
  return (
    <nav className="drawing-panel" aria-label="Drawing tools" data-testid="drawing-panel">
      {GROUPS.map((group, index) => (
        <Fragment key={group}>
          {index > 0 && <hr />}
          <div role="group" aria-label={GROUP_LABELS[group]}>
            {DRAWING_TOOLS.filter((t) => t.group === group).map((tool) => (
              <button
                key={tool.name}
                type="button"
                title={tool.label}
                aria-label={tool.label}
                aria-pressed={state.tool === tool.name}
                data-testid={`draw-${tool.name}`}
                onClick={() => layer.start(tool.name)}
              >
                <DrawingIcon name={tool.name} />
              </button>
            ))}
          </div>
        </Fragment>
      ))}
      <hr />
      <div role="group" aria-label="Drawing controls">
        <button
          type="button"
          title="Magnet: snap to bar open, high, low and close"
          aria-label="Magnet"
          aria-pressed={state.magnet}
          data-testid="draw-magnet"
          onClick={() => layer.setMagnet(!state.magnet)}
        >
          <DrawingIcon name="magnet" />
        </button>
        <button type="button" title="Lock all drawings" aria-label="Lock all drawings" aria-pressed={state.locked} data-testid="draw-lock" onClick={() => layer.setLocked(!state.locked)}>
          <DrawingIcon name="lock" />
        </button>
        <button type="button" title="Hide all drawings" aria-label="Hide all drawings" aria-pressed={state.hidden} data-testid="draw-hide" onClick={() => layer.setHidden(!state.hidden)}>
          <DrawingIcon name="hide" />
        </button>
        <button
          type="button"
          title={state.locked ? 'Unlock drawings to delete them' : 'Delete all drawings on this instrument'}
          aria-label="Delete all drawings"
          data-testid="draw-clear"
          disabled={state.count === 0 || state.locked}
          onClick={() => layer.clear()}
        >
          <DrawingIcon name="trash" />
        </button>
      </div>
    </nav>
  );
}
