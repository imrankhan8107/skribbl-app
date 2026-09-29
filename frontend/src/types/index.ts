// ---------------------------------------------------------------------------
// Shared TypeScript interfaces for the Skribbl frontend
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  hasGuessed: boolean;
  isConnected: boolean;
  isReady: boolean;
  avatar?: string;
  streak?: number;
  isFirstGuesser?: boolean;
  sessionWins?: number;
  sessionScore?: number;
  isSpectator?: boolean;
}

export interface MvpAward {
  badge: string;
  title: string;
  playerId: string;
  playerName: string;
  detail: string;
}

export interface SessionPlayerStat {
  id: string;
  name: string;
  sessionScore: number;
  sessionWins: number;
  sessionGames: number;
}

export interface GameConfig {
  numRounds: number; // 2–10
  turnDuration: number; // 30–180 seconds
  maxPlayers: number; // 2–12
  customWords?: string[];
  isPrivate?: boolean;
}

export type GamePhase = "idle" | "lobby" | "word_selection" | "playing" | "game_over";

export interface WordPackChoice {
  id: string;
  name: string;
  emoji: string;
  words: string[];
}

export interface RoundTheme {
  id: string;
  name: string;
  emoji: string;
}

export type DrawingAction =
  | { type: "stroke"; points: [number, number][]; color: string; size: number }
  | { type: "highlighter"; points: [number, number][]; color: string; size: number }
  | { type: "fill"; x: number; y: number; color: string }
  | { type: "line"; start: [number, number]; end: [number, number]; color: string; size: number }
  | { type: "rect"; start: [number, number]; end: [number, number]; color: string; size: number }
  | { type: "circle"; start: [number, number]; end: [number, number]; color: string; size: number };

export interface RoundArtwork {
  round: number;
  word: string;
  drawerId?: string;
  drawerName?: string;
  drawerAvatar?: string;
  imageDataUrl: string;
  theme?: string;
  replayActions?: DrawingAction[];
}

export interface JoinRequest {
  requestId: string;
  playerName: string;
  avatar?: string;
  roomCode: string;
}

export interface ActiveVoteKick {
  targetId: string;
  targetName: string;
  initiatorId: string;
  initiatorName: string;
  currentVotes: number;
  requiredVotes: number;
  timeoutSeconds?: number;
  hasVoted?: boolean;
}

export interface GameState {
  phase: GamePhase;
  roomCode: string | null;
  localPlayerId: string | null;
  isHost: boolean;
  isDrawer: boolean;
  isSpectator: boolean;
  players: PlayerInfo[];
  config: GameConfig;
  hint: string[]; // array of chars; '_' for hidden
  wordChoices: string[]; // word choices for drawer during word_selection phase
  wordPacks?: WordPackChoice[]; // pre-fetched 3 word packs with words for drawer
  currentTheme?: RoundTheme | null; // active theme for the ongoing round
  drawingEvent: { type: string; payload: unknown; id: number } | null; // latest remote drawing event
  currentWord: string | null; // the current word (only set for drawer)
  drawerId: string | null; // current drawer's player ID
  currentRound: number;
  totalRounds: number;
  timerSeconds: number;
  hasGuessed: boolean;
  errorMessage: string | null;
  chatMessages: ChatMessage[];
  waitingForReconnect: boolean;
  reconnectCountdown: number;
  artworkGallery?: RoundArtwork[];
  typingUsers?: Record<string, boolean>;
  mvpAwards?: MvpAward[];
  sessionStats?: SessionPlayerStat[];
  joinRequestPending?: boolean;
  pendingJoinRequestId?: string | null;
  pendingJoinRequests?: JoinRequest[];
  activeVoteKick?: ActiveVoteKick | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  type: "chat" | "correct_guess" | "system";
}

// ---------------------------------------------------------------------------
// Action union — dispatched by the WebSocket message handler (gameReducer)
// ---------------------------------------------------------------------------

export type Action =
  | { type: "ROOM_CREATED"; payload: { roomCode: string; playerId: string; config?: GameConfig } }
  | { type: "ROOM_JOINED"; payload: { roomCode: string; playerId: string; isHost: boolean } }
  | { type: "PLAYER_LIST"; payload: { players: PlayerInfo[] } }
  | { type: "SETTINGS_UPDATED"; payload: { config: GameConfig } }
  | {
      type: "GAME_STARTED";
      payload: { config?: GameConfig; totalRounds?: number; round?: number; drawerId?: string };
    }
  | {
      type: "WORD_CHOICES";
      payload: { choices: string[]; packs?: WordPackChoice[] };
    }
  | {
      type: "TURN_STARTED";
      payload: {
        drawerId: string;
        hint: string[];
        duration: number;
        round: number;
        theme?: RoundTheme;
      };
    }
  | { type: "HINT_UPDATE"; payload: { hint: string[] } }
  | {
      type: "TURN_ENDED";
      payload: {
        word: string;
        scores: Record<string, number>;
        players?: PlayerInfo[];
      };
    }
  | { type: "GUESS_CORRECT"; payload: { playerId: string; playerName: string; score: number } }
  | { type: "CHAT_MESSAGE"; payload: ChatMessage }
  | {
      type: "GAME_OVER";
      payload: {
        players?: PlayerInfo[];
        scores?: Array<{ id: string; name: string; score: number }>;
        mvpAwards?: MvpAward[];
        sessionStats?: SessionPlayerStat[];
      };
    }
  | { type: "PLAYER_RECONNECTED"; payload: { player: PlayerInfo } }
  | { type: "WAITING_FOR_RECONNECT"; payload: { seconds: number } }
  | { type: "RECONNECT_RESUMED"; payload: Record<string, never> }
  | {
      type: "RECONNECTED";
      payload: {
        roomCode: string;
        playerId: string;
        score: number;
        players: PlayerInfo[];
        config: GameConfig;
        state: string;
        currentRound: number;
        hostId: string;
        drawerId: string | null;
        hint: string[];
      };
    }
  | { type: "ERROR"; payload: { code: string; message: string } }
  | { type: "KICKED"; payload: { message: string } }
  | { type: "LEFT_ROOM"; payload: Record<string, never> }
  | { type: "REMATCH_STARTED"; payload: Record<string, unknown> }
  | { type: "SAVE_ARTWORK"; payload: RoundArtwork }
  | { type: "TYPING"; payload: { playerId: string; playerName: string; isTyping: boolean } }
  | { type: "PROFILE_UPDATED"; payload: { playerId: string; name?: string; avatar?: string } }
  | {
      type: "HOST_CHANGED";
      payload: {
        newHostId: string;
        newHostName: string;
        oldHostId: string;
        oldHostName: string;
      };
    }
  | {
      type: "HOST_TRANSFERRED";
      payload: {
        newHostId: string;
        newHostName: string;
      };
    }
  | {
      type: "JOIN_REQUEST_PENDING";
      payload: { requestId: string; roomCode: string; message?: string };
    }
  | {
      type: "JOIN_REQUEST_RECEIVED";
      payload: { requestId: string; playerName: string; avatar?: string; roomCode: string };
    }
  | {
      type: "JOIN_REQUEST_RESOLVED";
      payload: { requestId: string; status: string; playerName?: string };
    }
  | {
      type: "JOIN_REQUEST_DECLINED";
      payload: { requestId?: string; reason?: string; message: string };
    }
  | { type: "CANCEL_JOIN_REQUEST" }
  | {
      type: "VOTE_KICK_STARTED";
      payload: {
        target_id: string;
        target_name: string;
        initiator_id: string;
        initiator_name: string;
        current_votes: number;
        required_votes: number;
        timeout_seconds?: number;
      };
    }
  | {
      type: "VOTE_KICK_UPDATED";
      payload: {
        target_id?: string;
        current_votes: number;
        required_votes: number;
        result?: string;
      };
    }
  | {
      type: "VOTE_KICK_ENDED";
      payload: {
        target_id: string;
        target_name?: string;
        result: string;
        message?: string;
      };
    }
  | { type: "TICK" }
  | { type: "RESET" };
