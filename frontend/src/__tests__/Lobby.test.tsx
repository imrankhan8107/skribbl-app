import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState, PlayerInfo } from "../types";
import Lobby from "../pages/Lobby";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const twoPlayers: PlayerInfo[] = [
  { id: "p1", name: "Alice", score: 0, isHost: true, hasGuessed: false, isConnected: true, isReady: false },
  { id: "p2", name: "Bob", score: 0, isHost: false, hasGuessed: false, isConnected: true, isReady: false },
];

const defaultGameState: GameState = {
  phase: "lobby",
  roomCode: "ABC123",
  localPlayerId: "p1",
  isHost: true,
  isDrawer: false,
  players: twoPlayers,
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

function renderLobby(overrides: Partial<WebSocketContextValue> = {}) {
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
      <MemoryRouter initialEntries={["/lobby/ABC123"]}>
        <Lobby />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );

  return { ...utils, send, contextValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Lobby", () => {
  it("displays the room code prominently", () => {
    renderLobby();
    expect(screen.getByTestId("room-code")).toHaveTextContent("ABC123");
  });

  it("renders player list with all players", () => {
    renderLobby();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("highlights the host player", () => {
    renderLobby();
    expect(screen.getByText("(Host)")).toBeInTheDocument();
  });

  it("disables settings form for non-host players", () => {
    const gameState: GameState = {
      ...defaultGameState,
      isHost: false,
      localPlayerId: "p2",
    };
    renderLobby({ gameState });

    const fieldset = screen.getByRole("group");
    expect(fieldset).toBeDisabled();
  });

  it("enables settings form for host players", () => {
    renderLobby();
    const fieldset = screen.getByRole("group");
    expect(fieldset).not.toBeDisabled();
  });

  it("calls send with update_settings when rounds are changed by host", async () => {
    const user = userEvent.setup();
    const { send } = renderLobby();

    const roundsSelect = screen.getByLabelText(/rounds/i);
    await user.selectOptions(roundsSelect, "5");

    expect(send).toHaveBeenCalledWith("update_settings", { num_rounds: 5 });
  });

  it("calls send with start_game when Start Game button is clicked", async () => {
    const user = userEvent.setup();
    const { send } = renderLobby();

    const startBtn = screen.getByRole("button", { name: /start game/i });
    await user.click(startBtn);

    expect(send).toHaveBeenCalledWith("start_game");
  });

  it("disables Start Game button when player count < 2", () => {
    const gameState: GameState = {
      ...defaultGameState,
      players: [twoPlayers[0]], // only 1 player
    };
    renderLobby({ gameState });

    const startBtn = screen.getByRole("button", { name: /start game/i });
    expect(startBtn).toBeDisabled();
  });

  it("disables Start Game button when local player is not host", () => {
    const gameState: GameState = {
      ...defaultGameState,
      isHost: false,
      localPlayerId: "p2",
    };
    renderLobby({ gameState });

    const startBtn = screen.getByRole("button", { name: /start game/i });
    expect(startBtn).toBeDisabled();
  });

  it("enables Start Game button when host and 2+ players", () => {
    renderLobby();
    const startBtn = screen.getByRole("button", { name: /start game/i });
    expect(startBtn).not.toBeDisabled();
  });
});
