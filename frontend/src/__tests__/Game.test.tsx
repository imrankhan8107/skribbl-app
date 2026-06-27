import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState } from "../types";
import Game from "../pages/Game";

// ---------------------------------------------------------------------------
// Mock canvas context — jsdom doesn't support real Canvas API
// ---------------------------------------------------------------------------

function createMockCanvasContext() {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(800 * 600 * 4),
      width: 800,
      height: 600,
    })),
    putImageData: vi.fn(),
  };
}

let mockCtx: ReturnType<typeof createMockCanvasContext>;

beforeEach(() => {
  mockCtx = createMockCanvasContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => mockCtx as unknown as CanvasRenderingContext2D
  );
});

// ---------------------------------------------------------------------------
// Mock react-router-dom navigate
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ roomCode: "ABC123" }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultGameState: GameState = {
  phase: "playing",
  roomCode: "ABC123",
  localPlayerId: "player-1",
  isHost: false,
  isDrawer: false,
  players: [
    { id: "player-1", name: "Alice", score: 100, isHost: true, hasGuessed: false, isConnected: true, isReady: false },
    { id: "player-2", name: "Bob", score: 50, isHost: false, hasGuessed: true, isConnected: true, isReady: false },
  ],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: ["_", "e", "_", "_", "o"],
  wordChoices: [],
  drawingEvent: null,
  currentWord: null,
  drawerId: null,
  currentRound: 2,
  totalRounds: 3,
  timerSeconds: 45,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
  waitingForReconnect: false,
  reconnectCountdown: 0,
};

function renderGame(overrides: Partial<GameState> = {}) {
  const send = vi.fn();
  const dispatch = vi.fn();
  const contextValue: WebSocketContextValue = {
    gameState: { ...defaultGameState, ...overrides },
    send,
    dispatch,
    isConnected: true,
  };

  const utils = render(
    <WebSocketContext.Provider value={contextValue}>
      <MemoryRouter initialEntries={["/game/ABC123"]}>
        <Game />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );

  return { ...utils, send, dispatch, contextValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Game Page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Hint display (Requirement 12.5)", () => {
    it("renders hint characters correctly", () => {
      renderGame();
      const hintChars = screen.getAllByTestId("hint-char");
      expect(hintChars).toHaveLength(5);
      expect(hintChars[0]).toHaveTextContent("_");
      expect(hintChars[1]).toHaveTextContent("e");
      expect(hintChars[2]).toHaveTextContent("_");
      expect(hintChars[3]).toHaveTextContent("_");
      expect(hintChars[4]).toHaveTextContent("o");
    });

    it("renders hint with all underscores for fully hidden word", () => {
      renderGame({ hint: ["_", "_", "_"] });
      const hintChars = screen.getAllByTestId("hint-char");
      expect(hintChars).toHaveLength(3);
      hintChars.forEach((char) => {
        expect(char).toHaveTextContent("_");
      });
    });
  });

  describe("Timer (Requirement 12.4)", () => {
    it("dispatches TICK every second while phase is playing", () => {
      const { dispatch } = renderGame();

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(dispatch).toHaveBeenCalledWith({ type: "TICK" });

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // dispatch may be called more than twice due to React strict mode double-invoking effects
      expect(dispatch).toHaveBeenCalledWith({ type: "TICK" });
      const tickCalls = dispatch.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).type === "TICK"
      );
      expect(tickCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("does not dispatch TICK when phase is not playing", () => {
      const { dispatch } = renderGame({ phase: "lobby" });

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(dispatch).not.toHaveBeenCalledWith({ type: "TICK" });
    });
  });

  describe("Navigation to game over (Requirement 12.8)", () => {
    it("navigates to /gameover/:roomCode when phase becomes game_over", () => {
      renderGame({ phase: "game_over", roomCode: "ABC123" });
      expect(mockNavigate).toHaveBeenCalledWith("/gameover/ABC123");
    });

    it("does not navigate when phase is playing", () => {
      renderGame({ phase: "playing" });
      expect(mockNavigate).not.toHaveBeenCalledWith(
        expect.stringContaining("/gameover")
      );
    });
  });

  describe("Round indicator (Requirement 12.3)", () => {
    it("displays round and total rounds", () => {
      renderGame();
      const roundIndicator = screen.getByTestId("round-indicator");
      expect(roundIndicator).toHaveTextContent("Round 2 / 3");
    });
  });
});
