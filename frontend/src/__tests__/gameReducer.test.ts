import { describe, it, expect } from "vitest";
import { gameReducer } from "../context/WebSocketContext";
import type { GameState, Action, PlayerInfo, GameConfig } from "../types";

// ---------------------------------------------------------------------------
// Helper: default initial state (mirrors what WebSocketContext defines)
// ---------------------------------------------------------------------------

const initialState: GameState = {
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
// Tests
// ---------------------------------------------------------------------------

describe("gameReducer", () => {
  describe("ROOM_CREATED", () => {
    it("sets phase to lobby, stores roomCode and localPlayerId, sets isHost to true", () => {
      const action: Action = {
        type: "ROOM_CREATED",
        payload: { roomCode: "ABC123", playerId: "player-1" },
      };
      const next = gameReducer(initialState, action);
      expect(next.phase).toBe("lobby");
      expect(next.roomCode).toBe("ABC123");
      expect(next.localPlayerId).toBe("player-1");
      expect(next.isHost).toBe(true);
    });
  });

  describe("ROOM_JOINED", () => {
    it("sets phase to lobby, stores roomCode and playerId", () => {
      const action: Action = {
        type: "ROOM_JOINED",
        payload: { roomCode: "XYZ789", playerId: "player-2", isHost: false },
      };
      const next = gameReducer(initialState, action);
      expect(next.phase).toBe("lobby");
      expect(next.roomCode).toBe("XYZ789");
      expect(next.localPlayerId).toBe("player-2");
      expect(next.isHost).toBe(false);
    });

    it("sets isHost to true when payload indicates host", () => {
      const action: Action = {
        type: "ROOM_JOINED",
        payload: { roomCode: "XYZ789", playerId: "player-2", isHost: true },
      };
      const next = gameReducer(initialState, action);
      expect(next.isHost).toBe(true);
    });
  });

  describe("PLAYER_LIST", () => {
    it("updates players array", () => {
      const players: PlayerInfo[] = [
        { id: "p1", name: "Alice", score: 100, isHost: true, hasGuessed: false, isConnected: true, isReady: false },
        { id: "p2", name: "Bob", score: 50, isHost: false, hasGuessed: true, isConnected: true, isReady: false },
      ];
      const action: Action = { type: "PLAYER_LIST", payload: { players } };
      const next = gameReducer(initialState, action);
      expect(next.players).toEqual(players);
      expect(next.players).toHaveLength(2);
    });
  });

  describe("SETTINGS_UPDATED", () => {
    it("updates config", () => {
      const config: GameConfig = { numRounds: 5, turnDuration: 120, maxPlayers: 10 };
      const action: Action = { type: "SETTINGS_UPDATED", payload: { config } };
      const next = gameReducer(initialState, action);
      expect(next.config).toEqual(config);
    });
  });

  describe("GAME_STARTED", () => {
    it("sets phase to word_selection and updates config", () => {
      const config: GameConfig = { numRounds: 4, turnDuration: 60, maxPlayers: 6 };
      const action: Action = { type: "GAME_STARTED", payload: { config } };
      const state = { ...initialState, phase: "lobby" as const };
      const next = gameReducer(state, action);
      expect(next.phase).toBe("word_selection");
      expect(next.config).toEqual(config);
    });
  });

  describe("TURN_STARTED", () => {
    it("sets phase to playing, stores hint/duration/round, determines isDrawer when local player is drawer", () => {
      const state: GameState = { ...initialState, localPlayerId: "player-1" };
      const action: Action = {
        type: "TURN_STARTED",
        payload: {
          drawerId: "player-1",
          hint: ["_", "_", "_", " ", "_", "_"],
          duration: 80,
          round: 2,
        },
      };
      const next = gameReducer(state, action);
      expect(next.phase).toBe("playing");
      expect(next.hint).toEqual(["_", "_", "_", " ", "_", "_"]);
      expect(next.timerSeconds).toBe(80);
      expect(next.currentRound).toBe(2);
      expect(next.isDrawer).toBe(true);
      expect(next.hasGuessed).toBe(false);
    });

    it("sets isDrawer to false when local player is not the drawer", () => {
      const state: GameState = { ...initialState, localPlayerId: "player-2" };
      const action: Action = {
        type: "TURN_STARTED",
        payload: {
          drawerId: "player-1",
          hint: ["_", "_", "_"],
          duration: 60,
          round: 1,
        },
      };
      const next = gameReducer(state, action);
      expect(next.isDrawer).toBe(false);
    });
  });

  describe("HINT_UPDATE", () => {
    it("updates hint array", () => {
      const state: GameState = { ...initialState, hint: ["_", "_", "_", " ", "_", "_"] };
      const action: Action = {
        type: "HINT_UPDATE",
        payload: { hint: ["c", "_", "_", " ", "_", "_"] },
      };
      const next = gameReducer(state, action);
      expect(next.hint).toEqual(["c", "_", "_", " ", "_", "_"]);
    });
  });

  describe("TURN_ENDED", () => {
    it("applies score deltas and resets isDrawer and hasGuessed", () => {
      const players: PlayerInfo[] = [
        { id: "p1", name: "Alice", score: 100, isHost: true, hasGuessed: true, isConnected: true, isReady: false },
        { id: "p2", name: "Bob", score: 50, isHost: false, hasGuessed: true, isConnected: true, isReady: false },
      ];
      const state: GameState = { ...initialState, players, isDrawer: true, hasGuessed: true };
      const action: Action = {
        type: "TURN_ENDED",
        payload: {
          word: "apple",
          scores: { p1: 200, p2: 150 },
        },
      };
      const next = gameReducer(state, action);
      expect(next.players[0].score).toBe(300); // 100 + 200
      expect(next.players[1].score).toBe(200); // 50 + 150
      expect(next.isDrawer).toBe(false);
      expect(next.hasGuessed).toBe(false);
      expect(next.phase).toBe("word_selection");
    });
  });

  describe("GUESS_CORRECT", () => {
    it("adds a correct guess notification to chatMessages", () => {
      const state: GameState = { ...initialState, chatMessages: [] };
      const action: Action = {
        type: "GUESS_CORRECT",
        payload: { playerId: "p1", playerName: "Alice", score: 200 },
      };
      const next = gameReducer(state, action);
      expect(next.chatMessages).toHaveLength(1);
      expect(next.chatMessages[0].type).toBe("correct_guess");
      expect(next.chatMessages[0].text).toContain("Alice");
    });

    it("preserves existing chat messages when adding guess notification", () => {
      const existingMsg = {
        id: "existing",
        senderId: "p2",
        senderName: "Bob",
        text: "hello",
        type: "chat" as const,
      };
      const state: GameState = { ...initialState, chatMessages: [existingMsg] };
      const action: Action = {
        type: "GUESS_CORRECT",
        payload: { playerId: "p2", playerName: "Bob", score: 150 },
      };
      const next = gameReducer(state, action);
      expect(next.chatMessages).toHaveLength(2);
      expect(next.chatMessages[0]).toEqual(existingMsg);
      expect(next.chatMessages[1].type).toBe("correct_guess");
    });
  });

  describe("GAME_OVER", () => {
    it("sets phase to game_over and updates players", () => {
      const players: PlayerInfo[] = [
        { id: "p1", name: "Alice", score: 500, isHost: true, hasGuessed: false, isConnected: true, isReady: false },
        { id: "p2", name: "Bob", score: 300, isHost: false, hasGuessed: false, isConnected: true, isReady: false },
      ];
      const state: GameState = { ...initialState, phase: "playing" };
      const action: Action = { type: "GAME_OVER", payload: { players } };
      const next = gameReducer(state, action);
      expect(next.phase).toBe("game_over");
      expect(next.players).toEqual(players);
    });
  });

  describe("TICK", () => {
    it("decrements timerSeconds by 1", () => {
      const state: GameState = { ...initialState, timerSeconds: 45 };
      const action: Action = { type: "TICK" };
      const next = gameReducer(state, action);
      expect(next.timerSeconds).toBe(44);
    });

    it("never decrements below 0", () => {
      const state: GameState = { ...initialState, timerSeconds: 0 };
      const action: Action = { type: "TICK" };
      const next = gameReducer(state, action);
      expect(next.timerSeconds).toBe(0);
    });
  });

  describe("RESET", () => {
    it("returns to initial state", () => {
      const state: GameState = {
        ...initialState,
        phase: "game_over",
        roomCode: "ABC123",
        localPlayerId: "player-1",
        isHost: true,
        isDrawer: true,
        players: [
          { id: "p1", name: "Alice", score: 500, isHost: true, hasGuessed: false, isConnected: true, isReady: false },
        ],
        config: { numRounds: 10, turnDuration: 180, maxPlayers: 12 },
        hint: ["a", "p", "p", "l", "e"],
        currentRound: 5,
        totalRounds: 10,
        timerSeconds: 30,
        hasGuessed: true,
        errorMessage: "some error",
        chatMessages: [],
      };
      const action: Action = { type: "RESET" };
      const next = gameReducer(state, action);
      expect(next).toEqual(initialState);
    });
  });

  describe("ERROR", () => {
    it("sets errorMessage", () => {
      const action: Action = {
        type: "ERROR",
        payload: { code: "ROOM_NOT_FOUND", message: "Room not found" },
      };
      const next = gameReducer(initialState, action);
      expect(next.errorMessage).toBe("Room not found");
    });
  });
});
