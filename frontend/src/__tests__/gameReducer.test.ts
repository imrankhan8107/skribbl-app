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
        {
          id: "p1",
          name: "Alice",
          score: 100,
          isHost: true,
          hasGuessed: false,
          isConnected: true,
          isReady: false,
        },
        {
          id: "p2",
          name: "Bob",
          score: 50,
          isHost: false,
          hasGuessed: true,
          isConnected: true,
          isReady: false,
        },
      ];
      const action: Action = { type: "PLAYER_LIST", payload: { players } };
      const next = gameReducer(initialState, action);
      expect(next.players).toEqual(players);
      expect(next.players).toHaveLength(2);
    });

    it("preserves incoming avatars in PLAYER_LIST", () => {
      const players = [
        {
          id: "p1",
          name: "Alice",
          score: 100,
          isHost: true,
          hasGuessed: false,
          isConnected: true,
          isReady: false,
          avatar: "lion",
        },
        {
          id: "p2",
          name: "Bob",
          score: 50,
          isHost: false,
          hasGuessed: false,
          isConnected: true,
          isReady: false,
          avatar: "panda",
        },
      ];
      const action: Action = { type: "PLAYER_LIST", payload: { players: players as any } };
      const next = gameReducer(initialState, action);
      expect(next.players[0].avatar).toBe("lion");
      expect(next.players[1].avatar).toBe("panda");
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

  describe("WORD_CHOICES", () => {
    it("stores wordChoices, wordPacks, and marks local player as drawer", () => {
      const state: GameState = { ...initialState, localPlayerId: "player-1" };
      const action: Action = {
        type: "WORD_CHOICES",
        payload: {
          choices: ["dolphin", "pizza", "guitar"],
          packs: [
            {
              id: "animals",
              name: "Animals & Wildlife",
              emoji: "🐾",
              words: ["dolphin", "kangaroo", "turtle"],
            },
            {
              id: "food",
              name: "Food & Cuisine",
              emoji: "🍕",
              words: ["pizza", "waffle", "sushi"],
            },
            {
              id: "objects",
              name: "Everyday Objects",
              emoji: "📦",
              words: ["guitar", "telescope", "camera"],
            },
          ],
        },
      };
      const next = gameReducer(state, action);
      expect(next.isDrawer).toBe(true);
      expect(next.drawerId).toBe("player-1");
      expect(next.wordChoices).toEqual(["dolphin", "pizza", "guitar"]);
      expect(next.wordPacks).toHaveLength(3);
      expect(next.wordPacks?.[0].id).toBe("animals");
    });
  });

  describe("TURN_STARTED", () => {
    it("sets phase to playing, stores hint/duration/round, theme, determines isDrawer when local player is drawer", () => {
      const state: GameState = { ...initialState, localPlayerId: "player-1" };
      const action: Action = {
        type: "TURN_STARTED",
        payload: {
          drawerId: "player-1",
          hint: ["_", "_", "_", " ", "_", "_"],
          duration: 80,
          round: 2,
          theme: { id: "animals", name: "Animals & Wildlife", emoji: "🐾" },
        },
      };
      const next = gameReducer(state, action);
      expect(next.phase).toBe("playing");
      expect(next.hint).toEqual(["_", "_", "_", " ", "_", "_"]);
      expect(next.timerSeconds).toBe(80);
      expect(next.currentRound).toBe(2);
      expect(next.isDrawer).toBe(true);
      expect(next.hasGuessed).toBe(false);
      expect(next.currentTheme).toEqual({ id: "animals", name: "Animals & Wildlife", emoji: "🐾" });
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
        {
          id: "p1",
          name: "Alice",
          score: 100,
          isHost: true,
          hasGuessed: true,
          isConnected: true,
          isReady: false,
        },
        {
          id: "p2",
          name: "Bob",
          score: 50,
          isHost: false,
          hasGuessed: true,
          isConnected: true,
          isReady: false,
        },
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
        {
          id: "p1",
          name: "Alice",
          score: 500,
          isHost: true,
          hasGuessed: false,
          isConnected: true,
          isReady: false,
        },
        {
          id: "p2",
          name: "Bob",
          score: 300,
          isHost: false,
          hasGuessed: false,
          isConnected: true,
          isReady: false,
        },
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
          {
            id: "p1",
            name: "Alice",
            score: 500,
            isHost: true,
            hasGuessed: false,
            isConnected: true,
            isReady: false,
          },
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

  describe("SAVE_ARTWORK", () => {
    it("appends an artwork item to artworkGallery", () => {
      const artwork = {
        round: 1,
        word: "banana",
        drawerId: "p1",
        drawerName: "Alice",
        drawerAvatar: "🦁",
        imageDataUrl: "data:image/png;base64,sample123",
        theme: "Food & Drinks",
      };
      const action: Action = {
        type: "SAVE_ARTWORK",
        payload: artwork,
      };
      const next = gameReducer(initialState, action);
      expect(next.artworkGallery).toHaveLength(1);
      expect(next.artworkGallery![0]).toEqual(artwork);

      // Add a second artwork
      const artwork2 = {
        round: 2,
        word: "guitar",
        drawerId: "p2",
        drawerName: "Bob",
        imageDataUrl: "data:image/png;base64,sample456",
      };
      const next2 = gameReducer(next, { type: "SAVE_ARTWORK", payload: artwork2 });
      expect(next2.artworkGallery).toHaveLength(2);
      expect(next2.artworkGallery![1].word).toBe("guitar");
    });

    it("resets artworkGallery on ROOM_CREATED or ROOM_JOINED", () => {
      const stateWithArt = {
        ...initialState,
        artworkGallery: [
          {
            round: 1,
            word: "cat",
            imageDataUrl: "data:image/png;base64,cat",
          },
        ],
      };
      const created = gameReducer(stateWithArt, {
        type: "ROOM_CREATED",
        payload: { roomCode: "NEW123", playerId: "p1" },
      });
      expect(created.artworkGallery).toEqual([]);

      const joined = gameReducer(stateWithArt, {
        type: "ROOM_JOINED",
        payload: { roomCode: "JOIN456", playerId: "p2", isHost: false },
      });
      expect(joined.artworkGallery).toEqual([]);
    });
  });

  describe("Streak, First Guesser & TYPING", () => {
    it("sets isFirstGuesser and increments streak on GUESS_CORRECT", () => {
      const stateWithPlayers: GameState = {
        ...initialState,
        players: [
          {
            id: "p1",
            name: "Alice",
            score: 0,
            isHost: true,
            hasGuessed: false,
            isConnected: true,
            isReady: true,
          },
          {
            id: "p2",
            name: "Bob",
            score: 0,
            isHost: false,
            hasGuessed: false,
            isConnected: true,
            isReady: true,
          },
        ],
      };

      // First guesser (Alice)
      const afterAlice = gameReducer(stateWithPlayers, {
        type: "GUESS_CORRECT",
        payload: { playerName: "Alice", playerId: "p1", score: 100 },
      });
      expect(afterAlice.players[0].isFirstGuesser).toBe(true);
      expect(afterAlice.players[0].streak).toBe(1);

      // Second guesser (Bob) - should NOT be first guesser
      const afterBob = gameReducer(afterAlice, {
        type: "GUESS_CORRECT",
        payload: { playerName: "Bob", playerId: "p2", score: 80 },
      });
      expect(afterBob.players[1].isFirstGuesser).toBe(false);
      expect(afterBob.players[1].streak).toBe(1);
    });

    it("resets streak on TURN_ENDED if player did not guess", () => {
      const state: GameState = {
        ...initialState,
        drawerId: "p_drawer",
        players: [
          {
            id: "p1",
            name: "Alice",
            score: 100,
            isHost: true,
            hasGuessed: false, // didn't guess this turn!
            isConnected: true,
            isReady: true,
            streak: 3,
          },
        ],
      };

      const ended = gameReducer(state, {
        type: "TURN_ENDED",
        payload: { scores: {}, word: "apple" },
      });
      expect(ended.players[0].streak).toBe(0);
    });

    it("updates typingUsers map on TYPING action", () => {
      const typingAction: Action = {
        type: "TYPING",
        payload: { playerId: "p2", playerName: "Bob", isTyping: true },
      };
      const afterTyping = gameReducer(initialState, typingAction);
      expect(afterTyping.typingUsers?.["p2"]).toBe(true);

      const stoppedTypingAction: Action = {
        type: "TYPING",
        payload: { playerId: "p2", playerName: "Bob", isTyping: false },
      };
      const afterStopped = gameReducer(afterTyping, stoppedTypingAction);
      expect(afterStopped.typingUsers?.["p2"]).toBe(false);
    });
  });

  describe("HOST_CHANGED", () => {
    it("updates isHost flag on players and gameState", () => {
      const state: GameState = {
        ...initialState,
        localPlayerId: "p2",
        isHost: false,
        players: [
          {
            id: "p1",
            name: "Alice",
            score: 0,
            isHost: true,
            hasGuessed: false,
            isConnected: true,
            isReady: true,
          },
          {
            id: "p2",
            name: "Bob",
            score: 0,
            isHost: false,
            hasGuessed: false,
            isConnected: true,
            isReady: true,
          },
        ],
      };

      const action: Action = {
        type: "HOST_CHANGED",
        payload: {
          newHostId: "p2",
          newHostName: "Bob",
          oldHostId: "p1",
          oldHostName: "Alice",
        },
      };

      const next = gameReducer(state, action);
      expect(next.isHost).toBe(true);
      expect(next.players.find((p) => p.id === "p1")?.isHost).toBe(false);
      expect(next.players.find((p) => p.id === "p2")?.isHost).toBe(true);
    });
  });
});
