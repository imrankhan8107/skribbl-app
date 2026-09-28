import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  {
    id: "p1",
    name: "Alice",
    score: 300,
    isHost: true,
    hasGuessed: false,
    isConnected: true,
    isReady: false,
  },
  {
    id: "p2",
    name: "Bob",
    score: 500,
    isHost: false,
    hasGuessed: false,
    isConnected: true,
    isReady: false,
  },
  {
    id: "p3",
    name: "Charlie",
    score: 150,
    isHost: false,
    hasGuessed: false,
    isConnected: true,
    isReady: false,
  },
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
  wordChoices: [],
  drawingEvent: null,
  currentWord: null,
  drawerId: null,
  currentRound: 3,
  totalRounds: 3,
  timerSeconds: 0,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
  waitingForReconnect: false,
  reconnectCountdown: 0,
  artworkGallery: [],
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

  it("renders Masterpiece Gallery with artwork cards, opens modal, and closes modal", async () => {
    const user = userEvent.setup();
    const sampleArtwork = [
      {
        round: 1,
        word: "Elephant",
        drawerId: "p1",
        drawerName: "Alice",
        drawerAvatar: "🐘",
        imageDataUrl: "data:image/png;base64,mockElephantData",
        theme: "Animals",
      },
      {
        round: 2,
        word: "Pizza",
        drawerId: "p2",
        drawerName: "Bob",
        drawerAvatar: "🦁",
        imageDataUrl: "data:image/png;base64,mockPizzaData",
      },
    ];

    const gameState: GameState = {
      ...defaultGameState,
      artworkGallery: sampleArtwork,
    };

    renderGameOver({ gameState });

    // Check gallery exists
    const gallery = screen.getByTestId("masterpiece-gallery");
    expect(gallery).toBeInTheDocument();
    expect(within(gallery).getByText("🎨 Masterpiece Gallery")).toBeInTheDocument();

    // Check artwork cards inside gallery
    expect(within(gallery).getByText("Elephant")).toBeInTheDocument();
    expect(within(gallery).getByText("Animals")).toBeInTheDocument();
    expect(within(gallery).getByText("Alice")).toBeInTheDocument();
    expect(within(gallery).getByText("Pizza")).toBeInTheDocument();
    expect(within(gallery).getByText("Bob")).toBeInTheDocument();

    // Open lightbox modal by clicking the artwork thumbnail
    const firstCardImgWrap = screen.getByTitle("View drawing for Elephant");
    await user.click(firstCardImgWrap);

    // Modal should be open
    const modal = screen.getByTestId("gallery-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByText(/Drawn by Alice • Round 1 • Animals/)).toBeInTheDocument();

    // Close modal
    const closeBtn = screen.getByTestId("gallery-modal-close");
    await user.click(closeBtn);
    expect(screen.queryByTestId("gallery-modal")).not.toBeInTheDocument();
  });

  it("opens Replay modal from gallery card, displays controls, allows speed and scrubber interaction", async () => {
    const user = userEvent.setup();
    const sampleArtwork = [
      {
        round: 1,
        word: "Elephant",
        drawerId: "p1",
        drawerName: "Alice",
        drawerAvatar: "🐘",
        imageDataUrl: "data:image/png;base64,mockElephantData",
        replayActions: [
          {
            type: "stroke" as const,
            points: [
              [10, 10],
              [20, 20],
            ] as [number, number][],
            color: "#000000",
            size: 4,
          },
          {
            type: "stroke" as const,
            points: [
              [20, 20],
              [30, 30],
            ] as [number, number][],
            color: "#000000",
            size: 4,
          },
          {
            type: "fill" as const,
            x: 50,
            y: 50,
            color: "#ff0000",
          },
        ],
      },
    ];

    const gameState: GameState = {
      ...defaultGameState,
      artworkGallery: sampleArtwork,
    };

    renderGameOver({ gameState });

    // Click Replay button on card
    const replayBtn = screen.getByTestId("replay-artwork-0");
    await user.click(replayBtn);

    // Replay modal should be open
    const replayModal = screen.getByTestId("replay-modal");
    expect(replayModal).toBeInTheDocument();
    expect(within(replayModal).getByText(/🎬 Replay: Elephant/)).toBeInTheDocument();
    expect(screen.getByTestId("replay-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("replay-scrubber")).toBeInTheDocument();
    expect(screen.getByTestId("replay-counter")).toBeInTheDocument();

    // Speed toggles
    const speed2x = screen.getByTestId("replay-speed-2x");
    await user.click(speed2x);
    expect(speed2x).toHaveClass("active");

    const speed4x = screen.getByTestId("replay-speed-4x");
    await user.click(speed4x);
    expect(speed4x).toHaveClass("active");

    // Play/Pause button
    const playPauseBtn = screen.getByTestId("replay-play-pause-btn");
    expect(playPauseBtn).toBeInTheDocument();

    // Restart button
    const restartBtn = screen.getByTestId("replay-restart-btn");
    await user.click(restartBtn);

    // Close replay modal
    const closeBtn = screen.getByTestId("replay-modal-close");
    await user.click(closeBtn);
    expect(screen.queryByTestId("replay-modal")).not.toBeInTheDocument();
  });

  it("allows opening Replay modal from within the lightbox modal footer", async () => {
    const user = userEvent.setup();
    const sampleArtwork = [
      {
        round: 1,
        word: "Giraffe",
        drawerId: "p2",
        drawerName: "Bob",
        drawerAvatar: "🦒",
        imageDataUrl: "data:image/png;base64,mockGiraffeData",
        replayActions: [
          {
            type: "stroke" as const,
            points: [
              [100, 100],
              [150, 150],
            ] as [number, number][],
            color: "#ffaa00",
            size: 8,
          },
        ],
      },
    ];

    const gameState: GameState = {
      ...defaultGameState,
      artworkGallery: sampleArtwork,
    };

    renderGameOver({ gameState });

    // Open lightbox
    const thumbWrap = screen.getByTitle("View drawing for Giraffe");
    await user.click(thumbWrap);
    expect(screen.getByTestId("gallery-modal")).toBeInTheDocument();

    // Click "Watch Replay" button in lightbox footer
    const lightboxReplayBtn = screen.getByTestId("lightbox-replay-btn");
    await user.click(lightboxReplayBtn);

    // Lightbox should close and Replay modal should open
    expect(screen.queryByTestId("gallery-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("replay-modal")).toBeInTheDocument();
    expect(screen.getByText(/🎬 Replay: Giraffe/)).toBeInTheDocument();
  });
});
