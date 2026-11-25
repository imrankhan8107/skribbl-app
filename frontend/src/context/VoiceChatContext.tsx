import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  subscribeVoiceState,
  subscribeWebRtcSignal,
  type VoiceStateEvent,
  type WebRtcSignalEvent,
} from "./voiceBus";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface VoiceChatContextValue {
  inVoice: boolean;
  isMuted: boolean;
  voiceError: string | null;
  peerCount: number;
  joinVoice: () => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  clearVoiceError: () => void;
}

const VoiceChatContext = createContext<VoiceChatContextValue>({
  inVoice: false,
  isMuted: false,
  voiceError: null,
  peerCount: 0,
  joinVoice: async () => {},
  leaveVoice: () => {},
  toggleMute: () => {},
  clearVoiceError: () => {},
});

export function VoiceChatProvider({ children }: { children: React.ReactNode }) {
  const { gameState, send } = useWebSocket();
  const [inVoice, setInVoice] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const inVoiceRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const localPlayerIdRef = useRef<string | null>(gameState.localPlayerId);
  localPlayerIdRef.current = gameState.localPlayerId;

  const cleanupPeer = useCallback((peerId: string) => {
    const pc = peersRef.current.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      peersRef.current.delete(peerId);
    }
    const audio = audioElsRef.current.get(peerId);
    if (audio) {
      try {
        audio.srcObject = null;
        audio.remove();
      } catch {
        /* ignore */
      }
      audioElsRef.current.delete(peerId);
    }
  }, []);

  const leaveVoice = useCallback(() => {
    inVoiceRef.current = false;
    setInVoice(false);
    setIsMuted(false);

    for (const peerId of Array.from(peersRef.current.keys())) {
      cleanupPeer(peerId);
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (gameState.roomCode) {
      send("voice_state", { joined: false, muted: false });
    }
  }, [cleanupPeer, gameState.roomCode, send]);

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peersRef.current.set(peerId, pc);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current!);
        });
      }

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          send("webrtc_signal", {
            target_player_id: peerId,
            signal: { type: "candidate", candidate: evt.candidate.toJSON() },
          });
        }
      };

      pc.ontrack = (evt) => {
        const [stream] = evt.streams;
        if (!stream) return;
        let audio = audioElsRef.current.get(peerId);
        if (!audio) {
          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.setAttribute("playsinline", "true");
          audio.dataset.voicePeer = peerId;
          document.body.appendChild(audio);
          audioElsRef.current.set(peerId, audio);
        }
        audio.srcObject = stream;
        audio.play().catch(() => {
          /* autoplay policy handled via user click on Join Voice */
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          cleanupPeer(peerId);
        }
      };

      return pc;
    },
    [cleanupPeer, send]
  );

  const joinVoice = useCallback(async () => {
    setVoiceError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Voice chat requires HTTPS and a browser with microphone support.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;
      inVoiceRef.current = true;
      setInVoice(true);
      setIsMuted(false);
      send("voice_state", { joined: true, muted: false });

      // Initiate offers to peers already in voice (deterministic tie-breaker by ID)
      const myId = localPlayerIdRef.current;
      const existingPeers = Object.keys(gameState.voicePeers ?? {});
      for (const peerId of existingPeers) {
        if (!myId || peerId === myId) continue;
        const pc = createPeerConnection(peerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send("webrtc_signal", {
          target_player_id: peerId,
          signal: { type: "offer", sdp: pc.localDescription! },
        });
      }
    } catch {
      setVoiceError("Microphone permission denied or no microphone found.");
    }
  }, [createPeerConnection, gameState.voicePeers, send]);

  const toggleMute = useCallback(() => {
    if (!inVoiceRef.current || !localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
    send("voice_state", { joined: true, muted: nextMuted });
  }, [isMuted, send]);

  // Handle incoming WebRTC signaling (offer, answer, ICE candidate)
  useEffect(() => {
    return subscribeWebRtcSignal(async (evt: WebRtcSignalEvent) => {
      if (!inVoiceRef.current) return;
      const { fromPlayerId, signal } = evt;
      if (!fromPlayerId || !signal) return;

      try {
        if (signal.type === "offer" && signal.sdp) {
          const pc = createPeerConnection(fromPlayerId);
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send("webrtc_signal", {
            target_player_id: fromPlayerId,
            signal: { type: "answer", sdp: pc.localDescription! },
          });
        } else if (signal.type === "answer" && signal.sdp) {
          const pc = peersRef.current.get(fromPlayerId);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          }
        } else if (signal.type === "candidate" && signal.candidate) {
          const pc = peersRef.current.get(fromPlayerId);
          if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          }
        }
      } catch {
        /* ignore transient signaling race errors */
      }
    });
  }, [createPeerConnection, send]);

  // Clean up peer connections when a peer leaves voice
  useEffect(() => {
    return subscribeVoiceState((evt: VoiceStateEvent) => {
      if (!evt.joined && evt.playerId) {
        cleanupPeer(evt.playerId);
      }
    });
  }, [cleanupPeer]);

  // Auto-leave voice if the user leaves the room
  useEffect(() => {
    if (!gameState.roomCode && inVoiceRef.current) {
      leaveVoice();
    }
  }, [gameState.roomCode, leaveVoice]);

  const peerCount = Object.keys(gameState.voicePeers ?? {}).length;

  return (
    <VoiceChatContext.Provider
      value={{
        inVoice,
        isMuted,
        voiceError,
        peerCount,
        joinVoice,
        leaveVoice,
        toggleMute,
        clearVoiceError: () => setVoiceError(null),
      }}
    >
      {children}
    </VoiceChatContext.Provider>
  );
}

export function useVoiceChat(): VoiceChatContextValue {
  return useContext(VoiceChatContext);
}
