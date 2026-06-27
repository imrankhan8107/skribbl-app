import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState, PlayerInfo } from "../types";
import GameOver from "../pages/GameOver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const players: PlayerInfo[] = [
  { id: "p1", name: "Alice", score: 300, isHost: true, hasGuessed: false, isConnected: true, isReady: false },
  { id: "p2", name: "Bob", score: 500, isHost: false, hasGuessed: false, isConnected: true, isReady: false },
  { id: "p3", name: "Charlie", score: 150, isHost: false, hasGuessed: false, isConnected: true, isReady: false },
];

const defaultGameState: GameState = {
  phase: "game_over",
  roomCode: "XYZ789",
  localPlayerId: "p1",
  isHost: true,
  isDrawer: false,
  players,
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  currentRound: 3,
  totalRounds: 3,
  timerSeconds: 0,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
};

function renderGameOver(overrides: Partial<WebSocketContextValue> = {}) {
  const send = vi.fn();
  const contextValue: WebSocketContextValue = {
    gameState: defaultGameState,
    send,
    dispatch: vi.fn(),
    isConnected: true,
    ...overrides,
  };

  const utils = render(
    <WebSocketContext.Provider value={contextValue}>
      <MemoryRouter initialEntries={["/gameover/XYZ789"]}>
        <GameOver />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );

  return { ...utils, send, contextValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GameOver", () => {
  it("renders leaderboard with players sorted by score descending", () => {
    renderGameOver();

    const entries = screen.getAllByRole("listitem");
    expect(entries).toHaveLength(3);

    // Bob (500) should be first, Alice (300) second, Charlie (150) third
    expect(entries[0]).toHaveTextContent("Bob");
    expect(entries[0]).toHaveTextContent("500");
    expect(entries[1]).toHaveTextContent("Alice");
    expect(entries[1]).toHaveTextContent("300");
    expect(entries[2]).toHaveTextContent("Charlie");
    expect(entries[2]).toHaveTextContent("150");
  });

  it("renders position numbers for each player", () => {
    renderGameOver();

    const entries = screen.getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("1");
    expect(entries[1]).toHaveTextContent("2");
    expect(entries[2]).toHaveTextContent("3");
  });

  it("disables Rematch button for non-host players", () => {
    const gameState: GameState = {
      ...defaultGameState,
      isHost: false,
      localPlayerId: "p2",
    };
    renderGameOver({ gameState });

    const rematchBtn = screen.getByRole("button", { name: /rematch/i });
    expect(rematchBtn).toBeDisabled();
  });

  it("enables Rematch button for host players", () => {
    renderGameOver();

    const rematchBtn = screen.getByRole("button", { name: /rematch/i });
    expect(rematchBtn).not.toBeDisabled();
  });

  it("calls send('rematch') when host clicks Rematch button", async () => {
    const user = userEvent.setup();
    const { send } = renderGameOver();

    const rematchBtn = screen.getByRole("button", { name: /rematch/i });
    await user.click(rematchBtn);

    expect(send).toHaveBeenCalledWith("rematch");
  });
});
