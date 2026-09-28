// Reaction bus: enables real-time floating emoji animation over canvas
// Decoupled from React batching so fast bursts of emotes never lag or get dropped.

export interface ReactionEvent {
  id: string;
  emoji: string;
  playerName: string;
  playerId?: string;
  xPercent: number; // 10% to 90% across canvas width
  createdAt: number;
}

type ReactionListener = (event: ReactionEvent) => void;

const listeners = new Set<ReactionListener>();

/**
 * Subscribe to live reaction events. Returns an unsubscribe function.
 */
export function subscribeReaction(listener: ReactionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish a reaction event to all active listeners (e.g. FloatingReactions overlay).
 */
export function publishReaction(event: ReactionEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
