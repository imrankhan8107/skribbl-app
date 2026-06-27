import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState } from "../types";
import Landing from "../pages/Landing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultGameState: GameState = {
  phase: "idle",
  roomCode: null,
  localPlayerId: null,
  isHost: false,
  isDrawer: false,
  players: [],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  currentRound: 0,
  totalRounds: 0,
  timerSeconds: 0,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
};

function renderLanding(overrides: Partial<WebSocketContextValue> = {}) {
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
      <MemoryRouter initialEntries={["/"]}>
        <Landing />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );

  return { ...utils, send, contextValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Landing", () => {
  it("calls send with create_room and player name when Create Room is clicked", async () => {
    const user = userEvent.setup();
    const { send } = renderLanding();

    const nameInput = screen.getByLabelText(/player name/i);
    await user.type(nameInput, "Alice");

    const createBtn = screen.getByRole("button", { name: /create room/i });
    await user.click(createBtn);

    expect(send).toHaveBeenCalledWith("create_room", { name: "Alice" });
  });

  it("calls send with join_room, player name, and room code when Join Room is clicked", async () => {
    const user = userEvent.setup();
    const { send } = renderLanding();

    const nameInput = screen.getByLabelText(/player name/i);
    await user.type(nameInput, "Bob");

    const codeInput = screen.getByLabelText(/room code/i);
    await user.type(codeInput, "ABC123");

    const joinBtn = screen.getByRole("button", { name: /join room/i });
    await user.click(joinBtn);

    expect(send).toHaveBeenCalledWith("join_room", { name: "Bob", room_code: "ABC123" });
  });

  it("disables Create Room button when player name is empty", () => {
    renderLanding();
    const createBtn = screen.getByRole("button", { name: /create room/i });
    expect(createBtn).toBeDisabled();
  });

  it("disables Join Room button when player name or room code is empty", () => {
    renderLanding();
    const joinBtn = screen.getByRole("button", { name: /join room/i });
    expect(joinBtn).toBeDisabled();
  });

  it("displays error message when gameState has an errorMessage", () => {
    const gameState: GameState = {
      ...defaultGameState,
      errorMessage: "Room not found",
    };
    renderLanding({ gameState });

    expect(screen.getByRole("alert")).toHaveTextContent("Room not found");
  });

  it("displays ROOM_FULL error message", () => {
    const gameState: GameState = {
      ...defaultGameState,
      errorMessage: "Room is full",
    };
    renderLanding({ gameState });

    expect(screen.getByRole("alert")).toHaveTextContent("Room is full");
  });

  it("displays INVALID_NAME error message", () => {
    const gameState: GameState = {
      ...defaultGameState,
      errorMessage: "Invalid player name",
    };
    renderLanding({ gameState });

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid player name");
  });

  it("does not display error section when errorMessage is null", () => {
    renderLanding();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
