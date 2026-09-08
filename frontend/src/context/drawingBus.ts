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

export interface DrawingEvent {
  type: "stroke" | "fill" | "clear_canvas";
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
