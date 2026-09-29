import React, { createContext, useReducer, useRef, useCallback, useEffect, useState } from "react";
import type {
  GameState,
  Action,
  ChatMessage,
  PlayerInfo,
  MvpAward,
  SessionPlayerStat,
} from "../types";
import { publishDrawing, getCanvasSnapshot, getCanvasHistory } from "./drawingBus";
import { publishReaction } from "./reactionBus";
import { getStoredAvatarId, getStoredPlayerName, getAvatarForPlayer } from "../utils/avatars";

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialGameState: GameState = {
  phase: "idle",
  roomCode: null,
  localPlayerId: null,
  isHost: false,
  isDrawer: false,
  isSpectator: false,
  players: [],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  wordChoices: [],
  wordPacks: undefined,
  currentTheme: null,
  drawingEvent: null,
  currentWord: null,
  drawerId: null,
  currentRound: 0,
  totalRounds: 0,
  timerSeconds: 0,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
  waitingForReconnect: false,
  reconnectCountdown: 0,
  artworkGallery: [],
  typingUsers: {},
  mvpAwards: [],
  sessionStats: [],
  joinRequestPending: false,
  pendingJoinRequestId: null,
  pendingJoinRequests: [],
  activeVoteKick: null,
};

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

export function gameReducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "ROOM_CREATED": {
      const p = action.payload as Record<string, unknown>;
      const incomingPlayers = (p.players ?? []) as unknown as Array<Record<string, unknown>>;
      let players = state.players;
      if (incomingPlayers && incomingPlayers.length > 0) {
        players = incomingPlayers.map((pl) => {
          const avatar = (pl.avatar as string) || getStoredAvatarId() || undefined;
          const plObj: PlayerInfo = {
            id: (pl.id as string) ?? "",
            name: (pl.name as string) ?? "",
            score: (pl.score as number) ?? 0,
            hasGuessed: (pl.hasGuessed as boolean) ?? false,
            isConnected: (pl.isConnected as boolean) ?? true,
            isReady: (pl.isReady as boolean) ?? false,
            isHost: true,
          };
          if (avatar) plObj.avatar = avatar;
          return plObj;
        });
      }
      return {
        ...state,
        phase: "lobby",
        roomCode: action.payload.roomCode,
        localPlayerId: action.payload.playerId,
        isHost: true,
        config: action.payload.config ?? state.config,
        players,
        artworkGallery: [],
      };
    }

    case "ROOM_JOINED": {
      const p = action.payload as Record<string, unknown>;
      const incomingPlayers = (p.players ?? []) as unknown as Array<Record<string, unknown>>;
      const isSpectator = Boolean(p.isSpectator ?? p.is_spectator);
      let players = state.players;
      if (incomingPlayers && incomingPlayers.length > 0) {
        players = incomingPlayers.map((pl) => {
          const isLocal = pl.id === action.payload.playerId;
          const avatar = (pl.avatar as string) || (isLocal ? getStoredAvatarId() : undefined);
          const plObj: PlayerInfo = {
            id: (pl.id as string) ?? "",
            name: (pl.name as string) ?? "",
            score: (pl.score as number) ?? 0,
            hasGuessed: (pl.hasGuessed as boolean) ?? false,
            isConnected: (pl.isConnected as boolean) ?? true,
            isReady: (pl.isReady as boolean) ?? false,
            isHost: (pl.isHost as boolean) ?? pl.id === (p.hostId as string),
            isSpectator: Boolean(pl.isSpectator ?? pl.is_spectator),
          };
          if (avatar) plObj.avatar = avatar;
          return plObj;
        });
      }

      let phase: GameState["phase"] = "lobby";
      const roomState = (p.state as string) ?? "lobby";
      if (roomState === "playing") phase = "playing";
      else if (roomState === "word_selection") phase = "word_selection";
      else if (roomState === "game_over") phase = "game_over";

      const currentRound =
        (p.current_round as number) ?? (p.currentRound as number) ?? state.currentRound;
      const drawerId = (p.drawer_id as string | null) ?? (p.drawerId as string | null) ?? null;
      const hint = (p.hint as string[]) ?? state.hint;
      const timerSeconds = (p.duration as number) ?? state.timerSeconds;
      const currentTheme = (p.theme as GameState["currentTheme"]) ?? null;

      const hostId = (p.host_id as string) ?? (p.hostId as string);
      const isHost = action.payload.isHost ?? (hostId ? hostId === action.payload.playerId : false);

      return {
        ...state,
        phase,
        roomCode: action.payload.roomCode,
        localPlayerId: action.payload.playerId,
        isHost,
        isSpectator,
        drawerId,
        isDrawer: !isSpectator && drawerId === action.payload.playerId,
        currentRound,
        hint,
        timerSeconds,
        currentTheme,
        players,
        artworkGallery: [],
        joinRequestPending: false,
        pendingJoinRequestId: null,
      };
    }

    case "PLAYER_LIST": {
      // Server doesn't always send isHost — preserve it from current state or use incoming if present
      const incomingPlayers = (action.payload.players ?? []) as unknown as Array<
        Record<string, unknown>
      >;
      const updatedPlayers = incomingPlayers.map((p) => {
        const existing = state.players.find((ep) => ep.id === p.id);
        const isLocal =
          (state.localPlayerId && p.id === state.localPlayerId) ||
          (!state.localPlayerId && p.name === getStoredPlayerName());
        const resolvedAvatar =
          (p.avatar as string) || existing?.avatar || (isLocal ? getStoredAvatarId() : undefined);

        const playerObj: PlayerInfo = {
          id: (p.id as string) ?? "",
          name: (p.name as string) ?? "",
          score: (p.score as number) ?? 0,
          hasGuessed: (p.hasGuessed as boolean) ?? false,
          isConnected: (p.isConnected as boolean) ?? true,
          isReady: (p.isReady as boolean) ?? false,
          isHost: (p.isHost as boolean) ?? existing?.isHost ?? false,
          isSpectator: Boolean(p.isSpectator ?? p.is_spectator ?? existing?.isSpectator),
        };
        if (resolvedAvatar) {
          playerObj.avatar = resolvedAvatar;
        }
        if (p.streak !== undefined || existing?.streak !== undefined) {
          playerObj.streak = (p.streak as number) ?? existing?.streak;
        }
        if (p.isFirstGuesser !== undefined || existing?.isFirstGuesser !== undefined) {
          playerObj.isFirstGuesser = (p.isFirstGuesser as boolean) ?? existing?.isFirstGuesser;
        }
        return playerObj;
      });
      const localPlayer = updatedPlayers.find((p) => p.id === state.localPlayerId);
      const isHost = localPlayer ? localPlayer.isHost : state.isHost;
      return {
        ...state,
        players: updatedPlayers,
        isHost,
      };
    }

    case "PROFILE_UPDATED": {
      const { playerId, name, avatar } = action.payload;
      return {
        ...state,
        players: state.players.map((p) => {
          if (p.id !== playerId) return p;
          return {
            ...p,
            ...(name !== undefined ? { name } : {}),
            ...(avatar !== undefined ? { avatar } : {}),
          };
        }),
      };
    }

    case "HOST_CHANGED": {
      const { newHostId } = action.payload;
      const isLocalHost = Boolean(state.localPlayerId && state.localPlayerId === newHostId);
      return {
        ...state,
        isHost: isLocalHost,
        players: state.players.map((p) => ({
          ...p,
          isHost: p.id === newHostId,
        })),
      };
    }

    case "SETTINGS_UPDATED":
      return {
        ...state,
        config: action.payload.config,
      };

    case "GAME_STARTED":
      return {
        ...state,
        phase: "word_selection",
        config: action.payload.config ?? state.config,
        totalRounds: action.payload.totalRounds ?? state.totalRounds,
        currentRound: action.payload.round ?? state.currentRound,
        isDrawer: action.payload.drawerId === state.localPlayerId,
        drawerId: action.payload.drawerId ?? null,
      };

    case "WORD_CHOICES": {
      const p = action.payload as Record<string, unknown>;
      return {
        ...state,
        wordChoices: (p.choices as string[]) ?? [],
        wordPacks: (p.packs as GameState["wordPacks"]) ?? undefined,
        isDrawer: true, // If you receive word choices, you are the drawer
        drawerId: state.localPlayerId, // This player is the new drawer
      };
    }

    case "TURN_STARTED": {
      const p = action.payload as Record<string, unknown>;
      const freshPlayers = state.players.map((pl) => ({
        ...pl,
        hasGuessed: false,
        isFirstGuesser: false,
      }));
      return {
        ...state,
        phase: "playing",
        players: freshPlayers,
        hint: action.payload.hint,
        timerSeconds: action.payload.duration,
        currentRound: action.payload.round,
        isDrawer: action.payload.drawerId === state.localPlayerId,
        drawerId: action.payload.drawerId ?? state.drawerId,
        hasGuessed: false,
        wordChoices: [],
        wordPacks: undefined,
        currentTheme: (p.theme as GameState["currentTheme"]) ?? null,
        typingUsers: {},
        // Drawer keeps their currentWord, guessers clear it
        currentWord: action.payload.drawerId === state.localPlayerId ? state.currentWord : null,
      };
    }

    case "HINT_UPDATE":
      return {
        ...state,
        hint: action.payload.hint,
      };

    case "TURN_ENDED": {
      // Apply score deltas from the turn to players, and reset streak for anyone who didn't guess
      const scores = (action.payload as Record<string, unknown>).scores as
        Record<string, number> | undefined;
      const updatedPlayers = state.players.map((p) => {
        const delta = scores && typeof scores === "object" ? scores[p.id] : undefined;
        // Keep streak if they guessed, otherwise reset to 0 (unless they were the drawer)
        const wasDrawer = p.id === state.drawerId;
        const newStreak = p.hasGuessed || wasDrawer ? p.streak : 0;
        return {
          ...p,
          score: delta ? p.score + delta : p.score,
          hasGuessed: false,
          isFirstGuesser: false,
          streak: newStreak,
        };
      });
      return {
        ...state,
        players: updatedPlayers,
        isDrawer: false,
        hasGuessed: false,
        currentWord: null,
        drawerId: null, // Reset — new drawer will be set by WORD_CHOICES or TURN_STARTED
        currentTheme: null,
        typingUsers: {},
        // Transition back to word_selection for the next turn
        phase: "word_selection",
      };
    }

    case "GUESS_CORRECT": {
      const p = action.payload as Record<string, unknown>;
      const playerName = (p.playerName as string) ?? "Someone";
      const playerId = p.playerId as string | undefined;

      // Check if this is the first correct guess of this turn
      const isFirst = !state.players.some((pl) => pl.hasGuessed);

      const updatedPlayers = state.players.map((pl) => {
        const matches = (playerId && pl.id === playerId) || pl.name === playerName;
        if (matches) {
          return {
            ...pl,
            hasGuessed: true,
            isFirstGuesser: isFirst,
            streak: (pl.streak || 0) + 1,
          };
        }
        return pl;
      });

      // If local player guessed, mark local hasGuessed
      const localMatches =
        (playerId && state.localPlayerId === playerId) ||
        (!playerId &&
          state.players.find((pl) => pl.id === state.localPlayerId)?.name === playerName);

      // Add a correct guess notification to chat
      const guessMsg: ChatMessage = {
        id: String(Date.now()) + Math.random(),
        senderId: "",
        senderName: playerName,
        text: `${playerName} guessed the word!`,
        type: "correct_guess",
      };
      return {
        ...state,
        players: updatedPlayers,
        hasGuessed: localMatches ? true : state.hasGuessed,
        chatMessages: [...state.chatMessages, guessMsg],
      };
    }

    case "CHAT_MESSAGE": {
      const p = action.payload as unknown as Record<string, unknown>;
      const message: ChatMessage = {
        id: String(Date.now()) + Math.random(),
        senderId: (p.playerId as string) ?? "",
        senderName: (p.playerName as string) ?? "",
        text: (p.text as string) ?? "",
        type: p.isSystem ? "system" : "chat",
      };
      return {
        ...state,
        chatMessages: [...state.chatMessages, message],
      };
    }

    case "GAME_OVER": {
      // Server sends { scores: [{ id, name, score }, ...], mvp_awards, session_stats }
      const p = action.payload as Record<string, unknown>;
      const scores = p.scores as Array<{ id: string; name: string; score: number }> | undefined;
      const mvpAwards = (p.mvpAwards ?? p.mvp_awards) as MvpAward[] | undefined;
      const sessionStats = (p.sessionStats ?? p.session_stats) as SessionPlayerStat[] | undefined;
      const finalPlayers = scores
        ? scores.map((s) => {
            const existing = state.players.find((pl) => pl.id === s.id);
            const isLocal =
              (state.localPlayerId && s.id === state.localPlayerId) ||
              (!state.localPlayerId && s.name === getStoredPlayerName());
            const avatar =
              ((s as unknown as Record<string, unknown>).avatar as string) ||
              existing?.avatar ||
              (isLocal ? getStoredAvatarId() : undefined);
            const plObj: PlayerInfo = {
              id: s.id,
              name: s.name,
              score: s.score,
              isHost: existing?.isHost ?? false,
              hasGuessed: false,
              isConnected: true,
              isReady: false,
            };
            if (avatar) plObj.avatar = avatar;
            if (existing?.streak !== undefined) plObj.streak = existing.streak;
            const stat = sessionStats?.find((st) => st.id === s.id);
            if (stat) {
              plObj.sessionWins = stat.sessionWins;
              plObj.sessionScore = stat.sessionScore;
            } else if (existing?.sessionWins !== undefined) {
              plObj.sessionWins = existing.sessionWins;
              plObj.sessionScore = existing.sessionScore;
            }
            return plObj;
          })
        : ((p.players as typeof state.players) ?? state.players);
      return {
        ...state,
        phase: "game_over",
        players: finalPlayers,
        mvpAwards: mvpAwards ?? state.mvpAwards,
        sessionStats: sessionStats ?? state.sessionStats,
      };
    }

    case "PLAYER_RECONNECTED": {
      // Server sends { player_id, name } — mark that player as connected in our list
      const payload = action.payload as Record<string, unknown>;
      const reconnectedId = (payload.playerId as string) ?? "";
      if (!reconnectedId) return state;
      const newPlayers = state.players.map((p) =>
        p.id === reconnectedId ? { ...p, isConnected: true } : p
      );
      return {
        ...state,
        players: newPlayers,
        waitingForReconnect: false,
        reconnectCountdown: 0,
      };
    }

    case "WAITING_FOR_RECONNECT":
      return {
        ...state,
        waitingForReconnect: true,
        reconnectCountdown: ((action.payload as Record<string, unknown>).seconds as number) ?? 20,
      };

    case "RECONNECT_RESUMED":
      return {
        ...state,
        waitingForReconnect: false,
        reconnectCountdown: 0,
      };

    case "RECONNECTED": {
      const rp = action.payload as Record<string, unknown>;
      const rPlayers = (rp.players as typeof state.players) ?? [];
      const rConfig = (rp.config as typeof state.config) ?? state.config;
      const rState = (rp.state as string) ?? "lobby";
      const rHostId = (rp.hostId as string) ?? "";
      const rPlayerId = (rp.playerId as string) ?? state.localPlayerId;
      const rDrawerId = (rp.drawerId as string | null) ?? null;
      const rHint = (rp.hint as string[]) ?? [];
      const rCurrentRound = (rp.currentRound as number) ?? 0;

      let phase: GameState["phase"] = "lobby";
      if (rState === "playing") phase = "playing";
      else if (rState === "word_selection") phase = "word_selection";
      else if (rState === "game_over") phase = "game_over";

      const isSpectator = Boolean(
        rp.isSpectator ??
        rp.is_spectator ??
        rPlayers.find((pl) => pl.id === rPlayerId)?.isSpectator ??
        state.isSpectator
      );

      return {
        ...state,
        phase,
        roomCode: (rp.roomCode as string) ?? state.roomCode,
        localPlayerId: rPlayerId,
        isHost: rHostId === rPlayerId,
        isSpectator,
        players: rPlayers,
        config: rConfig,
        currentRound: rCurrentRound,
        totalRounds: rConfig.numRounds ?? state.totalRounds,
        drawerId: rDrawerId,
        isDrawer: !isSpectator && rDrawerId === rPlayerId,
        hint: rHint,
        waitingForReconnect: false,
        reconnectCountdown: 0,
      };
    }

    case "ERROR":
      return {
        ...state,
        errorMessage: action.payload.message,
      };

    case "SAVE_ARTWORK":
      return {
        ...state,
        artworkGallery: [...(state.artworkGallery ?? []), action.payload],
      };

    case "TYPING":
      return {
        ...state,
        typingUsers: {
          ...(state.typingUsers || {}),
          [action.payload.playerId]: action.payload.isTyping,
        },
      };

    case "TICK":
      return {
        ...state,
        timerSeconds: Math.max(0, state.timerSeconds - 1),
      };

    case "RESET":
      return {
        ...initialGameState,
      };

    case "KICKED": {
      sessionStorage.removeItem("skribbl_session");
      const kickPayload = action.payload as Record<string, unknown>;
      return {
        ...initialGameState,
        errorMessage: (kickPayload.message as string) ?? "You have been kicked",
      };
    }

    case "LEFT_ROOM":
      sessionStorage.removeItem("skribbl_session");
      return { ...initialGameState };

    case "JOIN_REQUEST_PENDING": {
      return {
        ...state,
        joinRequestPending: true,
        pendingJoinRequestId: action.payload.requestId,
        errorMessage: null,
      };
    }

    case "JOIN_REQUEST_RECEIVED": {
      const existing = state.pendingJoinRequests ?? [];
      const updated = existing.filter((r) => r.requestId !== action.payload.requestId);
      return {
        ...state,
        pendingJoinRequests: [...updated, action.payload],
      };
    }

    case "JOIN_REQUEST_RESOLVED": {
      const existing = state.pendingJoinRequests ?? [];
      const updated = existing.filter((r) => r.requestId !== action.payload.requestId);
      const isLocal = state.pendingJoinRequestId === action.payload.requestId;
      return {
        ...state,
        pendingJoinRequests: updated,
        ...(isLocal ? { joinRequestPending: false, pendingJoinRequestId: null } : {}),
      };
    }

    case "JOIN_REQUEST_DECLINED": {
      return {
        ...state,
        joinRequestPending: false,
        pendingJoinRequestId: null,
        errorMessage: action.payload.message || "Join request was declined.",
      };
    }

    case "CANCEL_JOIN_REQUEST": {
      return {
        ...state,
        joinRequestPending: false,
        pendingJoinRequestId: null,
      };
    }

    case "VOTE_KICK_STARTED": {
      const p = action.payload as unknown as Record<string, unknown>;
      const initiatorId = (p.initiatorId ?? p.initiator_id) as string;
      const targetId = (p.targetId ?? p.target_id) as string;
      const targetName = (p.targetName ?? p.target_name) as string;
      const initiatorName = (p.initiatorName ?? p.initiator_name) as string;
      const currentVotes = (p.currentVotes ?? p.current_votes ?? 1) as number;
      const requiredVotes = (p.requiredVotes ?? p.required_votes ?? 2) as number;
      const timeoutSeconds = (p.timeoutSeconds ?? p.timeout_seconds ?? 30) as number;
      const hasVoted = initiatorId === state.localPlayerId;
      return {
        ...state,
        activeVoteKick: {
          targetId,
          targetName,
          initiatorId,
          initiatorName,
          currentVotes,
          requiredVotes,
          timeoutSeconds,
          hasVoted,
        },
      };
    }

    case "VOTE_KICK_UPDATED": {
      if (!state.activeVoteKick) return state;
      const p = action.payload as unknown as Record<string, unknown>;
      const currentVotes = (p.currentVotes ??
        p.current_votes ??
        state.activeVoteKick.currentVotes) as number;
      const requiredVotes = (p.requiredVotes ??
        p.required_votes ??
        state.activeVoteKick.requiredVotes) as number;
      return {
        ...state,
        activeVoteKick: {
          ...state.activeVoteKick,
          currentVotes,
          requiredVotes,
        },
      };
    }

    case "VOTE_KICK_ENDED": {
      return {
        ...state,
        activeVoteKick: null,
      };
    }

    default: {
      // Handle custom local actions
      const act = action as unknown as { type: string; payload: unknown };
      // NOTE: drawing events (stroke/fill/clear_canvas) no longer flow through
      // the reducer — they are delivered synchronously via drawingBus so rapid
      // bursts are never collapsed by React batching. See drawingBus.ts.
      if (act.type === "WORD_SELECTED") {
        const p = act.payload as { word: string };
        return {
          ...state,
          currentWord: p.word,
        };
      }
      if (act.type === "DRAWER_SELECTING") {
        const p = act.payload as { drawer_id: string; drawer_name: string };
        return {
          ...state,
          drawerId: p.drawer_id,
          phase: "word_selection",
        };
      }
      if (act.type === "REMATCH_STARTED") {
        const p = act.payload as Record<string, unknown>;
        const rawPlayers = (p.players ?? []) as unknown as Array<Record<string, unknown>>;
        const players =
          rawPlayers.length > 0
            ? rawPlayers.map((pl) => {
                const existing = state.players.find((ep) => ep.id === pl.id);
                const isLocal =
                  (state.localPlayerId && pl.id === state.localPlayerId) ||
                  (!state.localPlayerId && pl.name === getStoredPlayerName());
                const avatar =
                  (pl.avatar as string) ||
                  existing?.avatar ||
                  (isLocal ? getStoredAvatarId() : undefined);
                const plObj: PlayerInfo = {
                  id: (pl.id as string) ?? "",
                  name: (pl.name as string) ?? "",
                  score: (pl.score as number) ?? 0,
                  hasGuessed: false,
                  isConnected: (pl.isConnected as boolean) ?? true,
                  isReady: (pl.isReady as boolean) ?? false,
                  isHost: (pl.isHost as boolean) ?? existing?.isHost ?? false,
                };
                if (avatar) plObj.avatar = avatar;
                return plObj;
              })
            : state.players.map((pl) => ({ ...pl, score: 0, hasGuessed: false, isReady: false }));
        const config = (p.config as typeof state.config) ?? state.config;
        return {
          ...initialGameState,
          phase: "lobby",
          roomCode: state.roomCode,
          localPlayerId: state.localPlayerId,
          isHost: state.isHost,
          players,
          config,
        };
      }
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface WebSocketContextValue {
  gameState: GameState;
  send: (type: string, payload?: unknown) => void;
  dispatch: React.Dispatch<Action>;
  isConnected: boolean;
  mutedPlayerIds: Set<string>;
  toggleMutePlayer: (playerId: string) => void;
}

export const WebSocketContext = createContext<WebSocketContextValue>({
  gameState: initialGameState,
  send: () => {},
  dispatch: () => {},
  isConnected: false,
  mutedPlayerIds: new Set(),
  toggleMutePlayer: () => {},
});

// ---------------------------------------------------------------------------
// Map server message type → Action type
// ---------------------------------------------------------------------------

function mapServerTypeToActionType(serverType: string): Action["type"] | null {
  const mapping: Record<string, Action["type"]> = {
    room_created: "ROOM_CREATED",
    room_joined: "ROOM_JOINED",
    player_list: "PLAYER_LIST",
    settings_updated: "SETTINGS_UPDATED",
    game_started: "GAME_STARTED",
    word_choices: "WORD_CHOICES",
    turn_started: "TURN_STARTED",
    hint_update: "HINT_UPDATE",
    turn_ended: "TURN_ENDED",
    guess_correct: "GUESS_CORRECT",
    chat_message: "CHAT_MESSAGE",
    game_over: "GAME_OVER",
    game_ended_insufficient_players: "GAME_OVER",
    rematch_started: "REMATCH_STARTED",
    player_reconnected: "PLAYER_RECONNECTED",
    waiting_for_reconnect: "WAITING_FOR_RECONNECT",
    reconnect_resumed: "RECONNECT_RESUMED",
    reconnected: "RECONNECTED",
    kicked: "KICKED",
    left_room: "LEFT_ROOM",
    typing: "TYPING",
    profile_updated: "PROFILE_UPDATED",
    host_changed: "HOST_CHANGED",
    host_transferred: "HOST_TRANSFERRED",
    join_request_pending: "JOIN_REQUEST_PENDING",
    join_request_received: "JOIN_REQUEST_RECEIVED",
    join_request_resolved: "JOIN_REQUEST_RESOLVED",
    join_request_declined: "JOIN_REQUEST_DECLINED",
    vote_kick_started: "VOTE_KICK_STARTED",
    vote_kick_updated: "VOTE_KICK_UPDATED",
    vote_kick_ended: "VOTE_KICK_ENDED",
    error: "ERROR",
  };
  return mapping[serverType] ?? null;
}

// ---------------------------------------------------------------------------
// Utility: convert snake_case keys to camelCase (shallow + one-level nested arrays)
// ---------------------------------------------------------------------------

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function mapKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(mapKeys);
  }
  if (obj !== null && typeof obj === "object") {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      mapped[snakeToCamel(key)] = mapKeys(value);
    }
    return mapped;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [gameState, dispatch] = useReducer(gameReducer, initialGameState);
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;
  const [isConnected, setIsConnected] = useState(false);
  const [mutedPlayerIds, setMutedPlayerIds] = useState<Set<string>>(() => new Set());

  const toggleMutePlayer = useCallback((playerId: string) => {
    setMutedPlayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      return next;
    });
  }, []);

  // Bumping this nonce forces the connection effect to tear down the current
  // socket and reconnect — used to follow a room-sticky redirect.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((type: string, payload?: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
      // Store the player name when creating or joining a room for auto-reconnect
      if (
        (type === "create_room" || type === "join_room") &&
        payload &&
        typeof payload === "object"
      ) {
        const p = payload as Record<string, unknown>;
        const name = p.name as string;
        if (name) {
          const existingSession = sessionStorage.getItem("skribbl_session");
          let roomCode = "";
          if (existingSession) {
            try {
              roomCode = JSON.parse(existingSession).roomCode;
            } catch {
              /* ignore */
            }
          }
          sessionStorage.setItem("skribbl_session", JSON.stringify({ playerName: name, roomCode }));
        }
      }
    }
  }, []);

  // redirectGatewayRef holds the owning gateway's ID when we were redirected
  // (room-sticky routing). We reconnect to the SAME origin with ?gw=<id> so the
  // LB consistent-hashes us onto the owner. Cleared is unnecessary — it only
  // pins subsequent reconnects to the correct gateway.
  const redirectGatewayRef = useRef<string | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    // Build the WS URL against the same public origin. Include ?room=<CODE> so
    // the LB can consistent-hash the connection to the gateway that owns the
    // room; include ?gw=<id> when we've been redirected so the LB pins us to
    // the owning gateway. Correctness never depends on the hash being perfect —
    // a misroute triggers a redirect that self-heals.
    let roomCode = "";
    const session = sessionStorage.getItem("skribbl_session");
    if (session) {
      try {
        roomCode = JSON.parse(session).roomCode || "";
      } catch {
        /* ignore */
      }
    }
    const params = new URLSearchParams();
    if (roomCode) params.set("room", roomCode);
    if (redirectGatewayRef.current) params.set("gw", redirectGatewayRef.current);
    // High-cardinality client id so create_room connections (which have no room
    // code yet) spread evenly across gateways at the LB hash. Without this, all
    // creators from one source IP hash to the same gateway, overloading it while
    // peers sit idle. Only meaningful for creates; joiners are pinned by ?room.
    if (!roomCode && !redirectGatewayRef.current) {
      params.set("cid", Math.random().toString(36).slice(2) + Date.now().toString(36));
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws${query}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // Auto-reconnect if we have stored session info
      const session = sessionStorage.getItem("skribbl_session");
      if (session) {
        try {
          const { playerName, roomCode } = JSON.parse(session);
          const path = window.location.pathname;
          if (path.includes("/game/") || path.includes("/lobby/")) {
            ws.send(
              JSON.stringify({
                type: "reconnect",
                payload: {
                  name: playerName,
                  room_code: roomCode,
                  avatar: getStoredAvatarId(),
                },
              })
            );
          }
        } catch {
          // Invalid session data, ignore
        }
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        console.log("[WS] Received:", msg.type, msg.payload);

        // Room-sticky routing: the gateway we connected to doesn't own our room.
        // Reconnect directly to the owning gateway's address. The server closes
        // this connection right after sending redirect; we reconnect on close
        // using redirectHostRef.
        if (msg.type === "redirect") {
          const gatewayId = msg.payload?.gateway_id as string | undefined;
          if (gatewayId) {
            console.log("[WS] Redirecting to owning gateway:", gatewayId);
            redirectGatewayRef.current = gatewayId;
            setReconnectNonce((n) => n + 1); // trigger the connection effect to re-run
          }
          return;
        }

        // Handle drawing events separately. Publish straight to the drawing bus
        // so the canvas renders every segment in order, synchronously. Routing
        // these through the reducer collapsed rapid bursts into a single slot
        // (React batching), dropping intermediate strokes -> dashed drawings.
        if (
          msg.type === "stroke" ||
          msg.type === "highlighter" ||
          msg.type === "shape" ||
          msg.type === "fill" ||
          msg.type === "clear_canvas" ||
          msg.type === "undo"
        ) {
          publishDrawing({ type: msg.type, payload: msg.payload });
          return;
        }

        // Handle reaction messages — publish to reaction bus for floating emotes and add as system chat message
        if (msg.type === "reaction") {
          const playerName = msg.payload?.player_name ?? "Someone";
          const emoji = msg.payload?.emoji ?? "";
          const playerId = msg.payload?.player_id;

          publishReaction({
            id: String(Date.now()) + Math.random().toString(36).slice(2),
            emoji,
            playerName,
            playerId,
            xPercent: 12 + Math.random() * 76,
            createdAt: Date.now(),
          });

          const reactionMsg: ChatMessage = {
            id: String(Date.now()) + Math.random(),
            senderId: "",
            senderName: playerName,
            text: `${playerName} reacted ${emoji}`,
            type: "system",
          };
          dispatch({ type: "CHAT_MESSAGE", payload: reactionMsg } as unknown as Action);
          return;
        }

        // Handle typing indicator messages
        if (msg.type === "typing") {
          dispatch({
            type: "TYPING",
            payload: {
              playerId: msg.payload?.player_id,
              playerName: msg.payload?.player_name,
              isTyping: Boolean(msg.payload?.is_typing),
            },
          });
          return;
        }

        // Handle word_assigned (sent privately to drawer on auto-select)
        if (msg.type === "word_assigned") {
          dispatch({
            type: "WORD_SELECTED",
            payload: { word: msg.payload.word },
          } as unknown as Action);
          return;
        }

        // Handle drawer_selecting (broadcast to all — sets drawerId for display)
        if (msg.type === "drawer_selecting") {
          dispatch({ type: "DRAWER_SELECTING", payload: msg.payload } as unknown as Action);
          return;
        }

        // On turn_ended, capture canvas snapshot for masterpiece gallery before state resets
        if (msg.type === "turn_ended") {
          const snapshot = getCanvasSnapshot();
          if (snapshot) {
            const word = (msg.payload?.word as string) || gameStateRef.current.currentWord || "";
            const drawerId = gameStateRef.current.drawerId;
            const drawer = gameStateRef.current.players.find((p) => p.id === drawerId);
            const drawerAvatarInfo = drawer
              ? getAvatarForPlayer(drawer.name || drawer.id, drawer.avatar)
              : null;
            const history = getCanvasHistory();
            dispatch({
              type: "SAVE_ARTWORK",
              payload: {
                round: gameStateRef.current.currentRound,
                word,
                drawerId: drawerId || undefined,
                drawerName: drawer?.name || "Anonymous",
                drawerAvatar: drawerAvatarInfo?.emoji || "🎨",
                imageDataUrl: snapshot,
                theme: gameStateRef.current.currentTheme?.name || undefined,
                replayActions: history && history.length > 0 ? history : undefined,
              },
            });
          }
        }

        const actionType = mapServerTypeToActionType(msg.type);
        if (actionType) {
          const payload = mapKeys(msg.payload) as Record<string, unknown>;
          console.log("[WS] Dispatching:", actionType, payload);

          // Store session info for auto-reconnect on page refresh
          if (
            msg.type === "room_created" ||
            msg.type === "room_joined" ||
            msg.type === "reconnected"
          ) {
            const roomCode = (payload as Record<string, unknown>).roomCode as string;
            // For room_created/room_joined, we need to get the player name from the payload or current state
            // The server doesn't echo the name back, so we store it when available
            const existingSession = sessionStorage.getItem("skribbl_session");
            let playerName = "";
            if (existingSession) {
              try {
                playerName = JSON.parse(existingSession).playerName;
              } catch {
                /* ignore */
              }
            }
            if (roomCode) {
              sessionStorage.setItem("skribbl_session", JSON.stringify({ playerName, roomCode }));
            }
          }

          // For game_ended_insufficient_players, wrap payload to match GAME_OVER action shape
          if (msg.type === "game_ended_insufficient_players") {
            dispatch({
              type: "GAME_OVER",
              payload: { players: (payload as Record<string, unknown>)?.players ?? [] },
            } as Action);
          } else {
            dispatch({ type: actionType, payload } as Action);
          }
        } else {
          console.log("[WS] No mapping for type:", msg.type);
        }
      } catch (err) {
        console.error("[WS] Error processing message:", err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      ws.close();
    };
    // reconnectNonce is bumped to follow a room-sticky redirect (reconnect to
    // the owning gateway). eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectNonce]);

  return (
    <WebSocketContext.Provider
      value={{
        gameState,
        dispatch,
        send,
        isConnected,
        mutedPlayerIds,
        toggleMutePlayer,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
}
