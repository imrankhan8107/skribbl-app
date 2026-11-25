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

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

export interface VoiceChatContextValue {
  inVoice: boolean;
  isMuted: boolean;
  voiceError: string | null;
  peerCount: number;
  inputDevices: AudioDeviceOption[];
  outputDevices: AudioDeviceOption[];
  selectedInputId: string;
  selectedOutputId: string;
  outputVolume: number;
  supportsOutputSelection: boolean;
  joinVoice: () => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  setInputDevice: (deviceId: string) => Promise<void>;
  setOutputDevice: (deviceId: string) => Promise<void>;
  setOutputVolume: (volume: number) => void;
  refreshDevices: () => Promise<void>;
  clearVoiceError: () => void;
}

const VoiceChatContext = createContext<VoiceChatContextValue>({
  inVoice: false,
  isMuted: false,
  voiceError: null,
  peerCount: 0,
  inputDevices: [],
  outputDevices: [],
  selectedInputId: "",
  selectedOutputId: "",
  outputVolume: 100,
  supportsOutputSelection: false,
  joinVoice: async () => {},
  leaveVoice: () => {},
  toggleMute: () => {},
  setInputDevice: async () => {},
  setOutputDevice: async () => {},
  setOutputVolume: () => {},
  refreshDevices: async () => {},
  clearVoiceError: () => {},
});

type AudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export function VoiceChatProvider({ children }: { children: React.ReactNode }) {
  const { gameState, send } = useWebSocket();
  const [inVoice, setInVoice] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioDeviceOption[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [outputVolume, setOutputVolumeState] = useState(100);

  const inVoiceRef = useRef(false);
  const isMutedRef = useRef(false);
  const outputVolumeRef = useRef(100);
  const selectedOutputIdRef = useRef("");
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const localPlayerIdRef = useRef<string | null>(gameState.localPlayerId);
  localPlayerIdRef.current = gameState.localPlayerId;

  const supportsOutputSelection =
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs: AudioDeviceOption[] = [];
      const outputs: AudioDeviceOption[] = [];
      let inIdx = 1;
      let outIdx = 1;

      for (const dev of devices) {
        if (dev.kind === "audioinput") {
          inputs.push({
            deviceId: dev.deviceId,
            label: dev.label || `Microphone ${inIdx++}`,
          });
        } else if (dev.kind === "audiooutput") {
          outputs.push({
            deviceId: dev.deviceId,
            label: dev.label || `Speaker ${outIdx++}`,
          });
        }
      }
      setInputDevices(inputs);
      setOutputDevices(outputs);
    } catch {
      /* ignore enumeration errors */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
      const handler = () => void refreshDevices();
      navigator.mediaDevices.addEventListener("devicechange", handler);
      return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
    }
    return undefined;
  }, [refreshDevices]);

  const applyOutputSettingsToAudio = useCallback(async (audio: HTMLAudioElement) => {
    audio.volume = Math.max(0, Math.min(1, outputVolumeRef.current / 100));
    const sinkId = selectedOutputIdRef.current;
    const sinkAudio = audio as AudioElementWithSink;
    if (sinkId && typeof sinkAudio.setSinkId === "function") {
      try {
        await sinkAudio.setSinkId(sinkId);
      } catch {
        /* ignore unsupported sinkId errors */
      }
    }
  }, []);

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
    isMutedRef.current = false;
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
        void applyOutputSettingsToAudio(audio);
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
    [applyOutputSettingsToAudio, cleanupPeer, send]
  );

  const getMicStream = useCallback(async (deviceId?: string) => {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    return navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  }, []);

  const joinVoice = useCallback(async () => {
    setVoiceError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Voice chat requires HTTPS and a browser with microphone support.");
      return;
    }
    try {
      const stream = await getMicStream(selectedInputId || undefined);
      localStreamRef.current = stream;
      inVoiceRef.current = true;
      isMutedRef.current = false;
      setInVoice(true);
      setIsMuted(false);

      const activeTrack = stream.getAudioTracks()[0];
      const activeDeviceId = activeTrack?.getSettings?.().deviceId;
      if (activeDeviceId) {
        setSelectedInputId(activeDeviceId);
      }
      await refreshDevices();

      send("voice_state", { joined: true, muted: false });

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
  }, [
    createPeerConnection,
    gameState.voicePeers,
    getMicStream,
    refreshDevices,
    selectedInputId,
    send,
  ]);

  const setInputDevice = useCallback(
    async (deviceId: string) => {
      setSelectedInputId(deviceId);
      if (!inVoiceRef.current) return;
      try {
        const newStream = await getMicStream(deviceId || undefined);
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        newTrack.enabled = !isMutedRef.current;

        for (const pc of peersRef.current.values()) {
          const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
          if (sender) {
            await sender.replaceTrack(newTrack);
          }
        }
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((t) => t.stop());
        }
        localStreamRef.current = newStream;
      } catch {
        setVoiceError("Failed to switch microphone device.");
      }
    },
    [getMicStream]
  );

  const setOutputDevice = useCallback(async (deviceId: string) => {
    selectedOutputIdRef.current = deviceId;
    setSelectedOutputId(deviceId);
    for (const audio of audioElsRef.current.values()) {
      const sinkAudio = audio as AudioElementWithSink;
      if (typeof sinkAudio.setSinkId === "function") {
        try {
          await sinkAudio.setSinkId(deviceId);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const setOutputVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    outputVolumeRef.current = clamped;
    setOutputVolumeState(clamped);
    for (const audio of audioElsRef.current.values()) {
      audio.volume = clamped / 100;
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (!inVoiceRef.current || !localStreamRef.current) return;
    const nextMuted = !isMutedRef.current;
    isMutedRef.current = nextMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
    send("voice_state", { joined: true, muted: nextMuted });
  }, [send]);

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

  useEffect(() => {
    return subscribeVoiceState((evt: VoiceStateEvent) => {
      if (!evt.joined && evt.playerId) {
        cleanupPeer(evt.playerId);
      }
    });
  }, [cleanupPeer]);

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
        inputDevices,
        outputDevices,
        selectedInputId,
        selectedOutputId,
        outputVolume,
        supportsOutputSelection,
        joinVoice,
        leaveVoice,
        toggleMute,
        setInputDevice,
        setOutputDevice,
        setOutputVolume,
        refreshDevices,
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
