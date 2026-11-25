// ---------------------------------------------------------------------------
// Voice Bus — lightweight pub/sub for WebRTC signaling & voice state events
// received over WebSocket, avoiding React reducer churn on ICE candidates.
// ---------------------------------------------------------------------------

export interface WebRtcSignalEvent {
  fromPlayerId: string;
  signal: {
    type?: "offer" | "answer" | "candidate";
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  };
}

export interface VoiceStateEvent {
  playerId: string;
  joined: boolean;
  muted: boolean;
  voicePeers: Record<string, { muted: boolean }>;
}

type SignalListener = (event: WebRtcSignalEvent) => void;
type VoiceStateListener = (event: VoiceStateEvent) => void;

const signalListeners = new Set<SignalListener>();
const stateListeners = new Set<VoiceStateListener>();

export function subscribeWebRtcSignal(listener: SignalListener): () => void {
  signalListeners.add(listener);
  return () => {
    signalListeners.delete(listener);
  };
}

export function publishWebRtcSignal(event: WebRtcSignalEvent): void {
  signalListeners.forEach((fn) => fn(event));
}

export function subscribeVoiceState(listener: VoiceStateListener): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function publishVoiceState(event: VoiceStateEvent): void {
  stateListeners.forEach((fn) => fn(event));
}
