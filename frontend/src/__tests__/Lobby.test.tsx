import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState, PlayerInfo } from "../types";
import Lobby from "../pages/Lobby";

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

const twoPlayers: PlayerInfo[] = [
  {
    id: "p1",
    name: "Alice",
    score: 0,
    isHost: true,
    hasGuessed: false,
    isConnected: true,
    isReady: false,
  },
  {
    id: "p2",
    name: "Bob",
    score: 0,
    isHost: false,
    hasGuessed: false,
    isConnected: true,
    isReady: false,
  },
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
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("redirects unauthenticated direct link visits without session to /?room=:roomCode", () => {
    const gameState: GameState = {
      ...defaultGameState,
      phase: "idle",
      roomCode: null,
    };
    renderLobby({ gameState });
    expect(mockNavigate).toHaveBeenCalledWith("/?room=ABC123", { replace: true });
  });

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

  it("renders the selected Lion avatar when stored in localStorage for local player", () => {
    localStorage.setItem("skribbl_player_avatar", "lion");
    renderLobby();
    const avatars = screen.getAllByTestId("player-avatar");
    // Local player (Alice, p1) should show Lion
    expect(avatars[0]).toHaveTextContent("🦁");
    expect(avatars[0]).toHaveAttribute("title", "Lion");
  });

  it("renders the explicit avatar when provided in PlayerInfo", () => {
    const playersWithAvatar: PlayerInfo[] = [
      {
        ...twoPlayers[0],
        avatar: "lion",
      },
      {
        ...twoPlayers[1],
        avatar: "panda",
      },
    ];
    const gameState: GameState = {
      ...defaultGameState,
      players: playersWithAvatar,
    };
    renderLobby({ gameState });
    const avatars = screen.getAllByTestId("player-avatar");
    expect(avatars[0]).toHaveTextContent("🦁");
    expect(avatars[1]).toHaveTextContent("🐼");
  });

  it("renders QR Code and Share buttons in lobby header", () => {
    renderLobby();
    expect(screen.getByTestId("lobby-qr-btn")).toBeInTheDocument();
    expect(screen.getByTestId("lobby-share-btn")).toBeInTheDocument();
  });

  it("opens QR Code modal, renders SVG QR code and details, and closes on clicking close", async () => {
    const user = userEvent.setup();
    renderLobby();

    const qrBtn = screen.getByTestId("lobby-qr-btn");
    await user.click(qrBtn);

    // Modal should be open
    const modal = screen.getByTestId("qr-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId("qr-svg")).toBeInTheDocument();
    expect(screen.getByTestId("qr-room-code")).toHaveTextContent("ABC123");
    expect(screen.getByTestId("qr-copy-link-btn")).toBeInTheDocument();
    expect(screen.getByTestId("qr-copy-code-btn")).toBeInTheDocument();

    // Close modal
    const closeBtn = screen.getByTestId("qr-modal-close");
    await user.click(closeBtn);
    expect(screen.queryByTestId("qr-modal")).not.toBeInTheDocument();
  });

  it("calls navigator.share when available upon clicking Share button", async () => {
    const user = userEvent.setup();
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      value: shareMock,
      configurable: true,
      writable: true,
    });

    renderLobby();
    const shareBtn = screen.getByTestId("lobby-share-btn");
    await user.click(shareBtn);

    expect(shareMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Join my Skribbl game!",
        text: expect.stringContaining("ABC123"),
        url: expect.stringContaining("room=ABC123"),
      })
    );
  });

  it("opens profile modal on clicking edit button, updates name and avatar, and sends update_profile", async () => {
    const user = userEvent.setup();
    const { send } = renderLobby();

    // Click edit profile button on local player item
    const editBtn = screen.getByTestId("player-edit-profile-btn");
    await user.click(editBtn);

    // Profile modal should be open
    const modal = screen.getByTestId("profile-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByText("🎨 Edit Profile")).toBeInTheDocument();

    // Change name
    const nameInput = screen.getByTestId("profile-name-input");
    await user.clear(nameInput);
    await user.type(nameInput, "Alicia");

    // Select Cat avatar
    const catBtn = screen.getByTitle("Cat");
    await user.click(catBtn);

    // Save
    const saveBtn = screen.getByTestId("profile-save-btn");
    await user.click(saveBtn);

    expect(send).toHaveBeenCalledWith("update_profile", {
      name: "Alicia",
      avatar: "cat",
    });
    expect(localStorage.getItem("skribbl_player_name")).toBe("Alicia");
    expect(localStorage.getItem("skribbl_player_avatar")).toBe("cat");
  });
});
