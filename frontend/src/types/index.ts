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
}

export interface GameConfig {
  numRounds: number;       // 2–10
  turnDuration: number;    // 30–180 seconds
  maxPlayers: number;      // 2–12
}

export type GamePhase =
  | "idle"
  | "lobby"
  | "word_selection"
  | "playing"
  | "game_over";

export interface GameState {
  phase: GamePhase;
  roomCode: string | null;
  localPlayerId: string | null;
  isHost: boolean;
  isDrawer: boolean;
  players: PlayerInfo[];
  config: GameConfig;
  hint: string[];           // array of chars; '_' for hidden
  wordChoices: string[];    // word choices for drawer during word_selection phase
  drawingEvent: { type: string; payload: unknown; id: number } | null;  // latest remote drawing event
  currentWord: string | null;  // the current word (only set for drawer)
  drawerId: string | null;     // current drawer's player ID
  currentRound: number;
  totalRounds: number;
  timerSeconds: number;
  hasGuessed: boolean;
  errorMessage: string | null;
  chatMessages: ChatMessage[];
  waitingForReconnect: boolean;
  reconnectCountdown: number;
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
  | { type: "ROOM_CREATED"; payload: { roomCode: string; playerId: string } }
  | { type: "ROOM_JOINED"; payload: { roomCode: string; playerId: string; isHost: boolean } }
  | { type: "PLAYER_LIST"; payload: { players: PlayerInfo[] } }
  | { type: "SETTINGS_UPDATED"; payload: { config: GameConfig } }
  | { type: "GAME_STARTED"; payload: { config: GameConfig } }
  | { type: "WORD_CHOICES"; payload: { choices: string[] } }
  | {
      type: "TURN_STARTED";
      payload: {
        drawerId: string;
        hint: string[];
        duration: number;
        round: number;
      };
    }
  | { type: "HINT_UPDATE"; payload: { hint: string[] } }
  | {
      type: "TURN_ENDED";
      payload: {
        word: string;
        scores: { playerId: string; delta: number }[];
        players: PlayerInfo[];
      };
    }
  | { type: "GUESS_CORRECT"; payload: { playerId: string; playerName: string; score: number } }
  | { type: "CHAT_MESSAGE"; payload: ChatMessage }
  | { type: "GAME_OVER"; payload: { players: PlayerInfo[] } }
  | { type: "PLAYER_RECONNECTED"; payload: { player: PlayerInfo } }
  | { type: "WAITING_FOR_RECONNECT"; payload: { seconds: number } }
  | { type: "RECONNECT_RESUMED"; payload: Record<string, never> }
  | { type: "RECONNECTED"; payload: { roomCode: string; playerId: string; score: number; players: PlayerInfo[]; config: GameConfig; state: string; currentRound: number; hostId: string; drawerId: string | null; hint: string[] } }
  | { type: "ERROR"; payload: { code: string; message: string } }
  | { type: "KICKED"; payload: { message: string } }
  | { type: "LEFT_ROOM"; payload: Record<string, never> }
  | { type: "TICK" }
  | { type: "RESET" };
