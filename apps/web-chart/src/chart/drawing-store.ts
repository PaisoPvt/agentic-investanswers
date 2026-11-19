// Where drawings are kept (UI-01): in the browser's local storage, per account
// and instrument, until they are saved with the account on the server
// (decision record T-10). Storage can be missing or refuse (private windows,
// blocked site data), so every read and write is guarded: the chart works,
// the drawings just do not outlive the page.

/** One point of a drawing: a bar time (ms, as KLineChart uses) and a price. */
export interface DrawingPoint {
  readonly timestamp: number;
  readonly value: number;
}

export interface SavedDrawing {
  /** The tool's overlay name (drawing-tools.ts). */
  readonly name: string;
  readonly points: readonly DrawingPoint[];
  /** A text note's text. */
  readonly text?: string;
}

/** The part of the Web Storage API used here. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const VERSION = 'v1';

function isPoint(value: unknown): value is DrawingPoint {
  if (typeof value !== 'object' || value === null) return false;
  const { timestamp, value: price } = value as Record<string, unknown>;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && typeof price === 'number' && Number.isFinite(price);
}

function isDrawing(value: unknown): value is SavedDrawing {
  if (typeof value !== 'object' || value === null) return false;
  const { name, points, text } = value as Record<string, unknown>;
  return typeof name === 'string' && Array.isArray(points) && points.length > 0 && points.every(isPoint) && (text === undefined || typeof text === 'string');
}

export class DrawingStore {
  constructor(
    private readonly storage: () => KeyValueStorage | undefined,
    /** Whose drawings: the account id, or a fixed name in developer access. */
    private readonly owner: string,
  ) {}

  private key(instrument: string): string {
    return `aia.drawings.${VERSION}.${this.owner}.${instrument}`;
  }

  /** The instrument's drawings; none when storage is unavailable or what is stored is not ours. */
  load(instrument: string): SavedDrawing[] {
    try {
      const raw = this.storage()?.getItem(this.key(instrument));
      if (raw === null || raw === undefined) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isDrawing) : [];
    } catch {
      return [];
    }
  }

  /** Replaces the instrument's drawings. Returns false when they could not be kept. */
  save(instrument: string, drawings: readonly SavedDrawing[]): boolean {
    try {
      const storage = this.storage();
      if (storage === undefined) return false;
      if (drawings.length === 0) storage.removeItem(this.key(instrument));
      else storage.setItem(this.key(instrument), JSON.stringify(drawings));
      return true;
    } catch {
      return false;
    }
  }
}

/** The browser's local storage, or none where reading it throws. */
export function browserStorage(): KeyValueStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
