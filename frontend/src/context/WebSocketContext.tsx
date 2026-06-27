import React, {
  createContext,
  useReducer,
  useRef,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { GameState, Action, ChatMessage } from "../types";

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialGameState: GameState = {
  phase: "idle",
  roomCode: null,
  localPlayerId: null,
  isHost: false,
  isDrawer: false,
  players: [],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  wordChoices: [],
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
};

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

export function gameReducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "ROOM_CREATED":
      return {
        ...state,
        phase: "lobby",
        roomCode: action.payload.roomCode,
        localPlayerId: action.payload.playerId,
        isHost: true,
        config: action.payload.config ?? state.config,
      };

    case "ROOM_JOINED":
      return {
        ...state,
        phase: "lobby",
        roomCode: action.payload.roomCode,
        localPlayerId: action.payload.playerId,
        isHost: action.payload.isHost,
      };

    case "PLAYER_LIST": {
      // Server doesn't always send isHost — preserve it from current state or use incoming if present
      const incomingPlayers = action.payload.players as Array<Record<string, unknown>> ?? [];
      const updatedPlayers = incomingPlayers.map((p) => ({
        id: (p.id as string) ?? "",
        name: (p.name as string) ?? "",
        score: (p.score as number) ?? 0,
        hasGuessed: (p.hasGuessed as boolean) ?? false,
        isConnected: (p.isConnected as boolean) ?? true,
        isReady: (p.isReady as boolean) ?? false,
        isHost: (p.isHost as boolean) ?? state.players.find((existing) => existing.id === p.id)?.isHost ?? false,
      }));
      return {
        ...state,
        players: updatedPlayers,
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

    case "WORD_CHOICES":
      return {
        ...state,
        wordChoices: (action.payload as Record<string, unknown>).choices as string[] ?? [],
        isDrawer: true,  // If you receive word choices, you are the drawer
        drawerId: state.localPlayerId,  // This player is the new drawer
      };

    case "TURN_STARTED":
      return {
        ...state,
        phase: "playing",
        hint: action.payload.hint,
        timerSeconds: action.payload.duration,
        currentRound: action.payload.round,
        isDrawer: action.payload.drawerId === state.localPlayerId,
        drawerId: action.payload.drawerId ?? state.drawerId,
        hasGuessed: false,
        wordChoices: [],
        // Drawer keeps their currentWord, guessers clear it
        currentWord: action.payload.drawerId === state.localPlayerId ? state.currentWord : null,
      };

    case "HINT_UPDATE":
      return {
        ...state,
        hint: action.payload.hint,
      };

    case "TURN_ENDED": {
      // Apply score deltas from the turn to players
      const scores = (action.payload as Record<string, unknown>).scores as Record<string, number> | undefined;
      let updatedPlayers = state.players;
      if (scores && typeof scores === "object") {
        updatedPlayers = state.players.map((p) => {
          const delta = scores[p.id];
          return delta ? { ...p, score: p.score + delta, hasGuessed: false } : { ...p, hasGuessed: false };
        });
      }
      return {
        ...state,
        players: updatedPlayers,
        isDrawer: false,
        hasGuessed: false,
        currentWord: null,
        drawerId: null,  // Reset — new drawer will be set by WORD_CHOICES or TURN_STARTED
        // Transition back to word_selection for the next turn
        phase: "word_selection",
      };
    }

    case "GUESS_CORRECT": {
      const playerName = (action.payload as Record<string, unknown>).playerName as string ?? "Someone";
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
        chatMessages: [...state.chatMessages, guessMsg],
      };
    }

    case "CHAT_MESSAGE": {
      const p = action.payload as Record<string, unknown>;
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
      // Server sends { scores: [{ id, name, score }, ...] } — map to players format
      const p = action.payload as Record<string, unknown>;
      const scores = p.scores as Array<{ id: string; name: string; score: number }> | undefined;
      const finalPlayers = scores
        ? scores.map((s) => ({
            id: s.id,
            name: s.name,
            score: s.score,
            isHost: state.players.find((pl) => pl.id === s.id)?.isHost ?? false,
            hasGuessed: false,
            isConnected: true,
          }))
        : (p.players as typeof state.players) ?? state.players;
      return {
        ...state,
        phase: "game_over",
        players: finalPlayers,
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
        reconnectCountdown: (action.payload as Record<string, unknown>).seconds as number ?? 20,
      };

    case "RECONNECT_RESUMED":
      return {
        ...state,
        waitingForReconnect: false,
        reconnectCountdown: 0,
      };

    case "RECONNECTED": {
      const rp = action.payload as Record<string, unknown>;
      const rPlayers = rp.players as typeof state.players ?? [];
      const rConfig = rp.config as typeof state.config ?? state.config;
      const rState = rp.state as string ?? "lobby";
      const rHostId = rp.hostId as string ?? "";
      const rPlayerId = rp.playerId as string ?? state.localPlayerId;
      const rDrawerId = rp.drawerId as string | null ?? null;
      const rHint = rp.hint as string[] ?? [];
      const rCurrentRound = rp.currentRound as number ?? 0;

      let phase: GameState["phase"] = "lobby";
      if (rState === "playing") phase = "playing";
      else if (rState === "word_selection") phase = "word_selection";
      else if (rState === "game_over") phase = "game_over";

      return {
        ...state,
        phase,
        roomCode: rp.roomCode as string ?? state.roomCode,
        localPlayerId: rPlayerId,
        isHost: rHostId === rPlayerId,
        players: rPlayers,
        config: rConfig,
        currentRound: rCurrentRound,
        totalRounds: rConfig.numRounds ?? state.totalRounds,
        drawerId: rDrawerId,
        isDrawer: rDrawerId === rPlayerId,
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
      sessionStorage.removeItem('skribbl_session');
      const kickPayload = action.payload as Record<string, unknown>;
      return { ...initialGameState, errorMessage: (kickPayload.message as string) ?? "You have been kicked" };
    }

    case "LEFT_ROOM":
      sessionStorage.removeItem('skribbl_session');
      return { ...initialGameState };

    default: {
      // Handle custom local actions
      const act = action as unknown as { type: string; payload: unknown };
      if (act.type === "DRAWING_EVENT") {
        const event = act.payload as { type: string; payload: unknown };
        return {
          ...state,
          drawingEvent: { ...event, id: Date.now() + Math.random() },
        };
      }
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
        const players = p.players as typeof state.players ?? [];
        const config = p.config as typeof state.config ?? state.config;
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
}

export const WebSocketContext = createContext<WebSocketContextValue>({
  gameState: initialGameState,
  send: () => {},
  dispatch: () => {},
  isConnected: false,
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
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((type: string, payload?: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
      // Store the player name when creating or joining a room for auto-reconnect
      if ((type === "create_room" || type === "join_room") && payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        const name = p.name as string;
        if (name) {
          const existingSession = sessionStorage.getItem('skribbl_session');
          let roomCode = '';
          if (existingSession) {
            try { roomCode = JSON.parse(existingSession).roomCode; } catch { /* ignore */ }
          }
          sessionStorage.setItem('skribbl_session', JSON.stringify({ playerName: name, roomCode }));
        }
      }
    }
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // Auto-reconnect if we have stored session info
      const session = sessionStorage.getItem('skribbl_session');
      if (session) {
        try {
          const { playerName, roomCode } = JSON.parse(session);
          const path = window.location.pathname;
          if (path.includes('/game/') || path.includes('/lobby/')) {
            ws.send(JSON.stringify({ type: 'reconnect', payload: { name: playerName, room_code: roomCode } }));
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

        // Handle drawing events separately — store as drawingEvent
        if (msg.type === "stroke" || msg.type === "fill" || msg.type === "clear_canvas") {
          dispatch({ type: "DRAWING_EVENT", payload: { type: msg.type, payload: msg.payload } } as unknown as Action);
          return;
        }

        // Handle reaction messages — add as system chat message
        if (msg.type === "reaction") {
          const playerName = msg.payload?.player_name ?? "Someone";
          const emoji = msg.payload?.emoji ?? "";
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

        // Handle word_assigned (sent privately to drawer on auto-select)
        if (msg.type === "word_assigned") {
          dispatch({ type: "WORD_SELECTED", payload: { word: msg.payload.word } } as unknown as Action);
          return;
        }

        // Handle drawer_selecting (broadcast to all — sets drawerId for display)
        if (msg.type === "drawer_selecting") {
          dispatch({ type: "DRAWER_SELECTING", payload: msg.payload } as unknown as Action);
          return;
        }

        const actionType = mapServerTypeToActionType(msg.type);
        if (actionType) {
          const payload = mapKeys(msg.payload) as Record<string, unknown>;
          console.log("[WS] Dispatching:", actionType, payload);

          // Store session info for auto-reconnect on page refresh
          if (msg.type === "room_created" || msg.type === "room_joined" || msg.type === "reconnected") {
            const roomCode = (payload as Record<string, unknown>).roomCode as string;
            // For room_created/room_joined, we need to get the player name from the payload or current state
            // The server doesn't echo the name back, so we store it when available
            const existingSession = sessionStorage.getItem('skribbl_session');
            let playerName = '';
            if (existingSession) {
              try { playerName = JSON.parse(existingSession).playerName; } catch { /* ignore */ }
            }
            if (roomCode) {
              sessionStorage.setItem('skribbl_session', JSON.stringify({ playerName, roomCode }));
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
  }, []);

  return (
    <WebSocketContext.Provider value={{ gameState, dispatch, send, isConnected }}>
      {children}
    </WebSocketContext.Provider>
  );
}
