// ---------------------------------------------------------------------------
// drawingBus — synchronous pub/sub for incoming drawing events.
//
// WHY THIS EXISTS:
// Drawing events (stroke/fill/clear_canvas) arrive as a rapid burst of tiny
// 2-point segments. Previously each event was dispatched into a SINGLE
// `drawingEvent` slot in the game reducer. React batches reducer dispatches, so
// when several strokes arrived within one tick only the LAST survived before the
// Canvas effect ran — every intermediate segment was silently dropped, which is
// exactly what produced the "dashed"/broken remote drawings.
//
// This bus delivers each drawing event straight to the canvas the instant it is
// received off the WebSocket, in order, with no reducer state and no React
// batching in the path. State that other components care about is untouched.
// ---------------------------------------------------------------------------

import type { DrawingAction } from "../types";

export interface DrawingEvent {
  type: "stroke" | "fill" | "clear_canvas" | "undo";
  payload: unknown;
}

type Listener = (event: DrawingEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to drawing events. Returns an unsubscribe function. */
export function subscribeDrawing(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish a drawing event to all current subscribers synchronously. */
export function publishDrawing(event: DrawingEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

let snapshotGetter: (() => string | null) | null = null;

/** Register active canvas snapshot provider. Returns an unsubscribe function. */
export function registerCanvasSnapshotter(getter: () => string | null): () => void {
  snapshotGetter = getter;
  return () => {
    if (snapshotGetter === getter) {
      snapshotGetter = null;
    }
  };
}

/** Capture base64 PNG data URL of the canvas artwork right now. */
export function getCanvasSnapshot(): string | null {
  return snapshotGetter ? snapshotGetter() : null;
}

let historyGetter: (() => DrawingAction[]) | null = null;

/** Register active canvas action history provider. Returns an unsubscribe function. */
export function registerCanvasHistoryGetter(getter: () => DrawingAction[]): () => void {
  historyGetter = getter;
  return () => {
    if (historyGetter === getter) {
      historyGetter = null;
    }
  };
}

/** Get list of drawing actions recorded during this turn. */
export function getCanvasHistory(): DrawingAction[] {
  return historyGetter ? historyGetter() : [];
}
