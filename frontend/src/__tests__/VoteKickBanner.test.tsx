import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VoteKickBanner from "../components/VoteKickBanner";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState } from "../types";

const defaultGameState: GameState = {
  phase: "lobby",
  roomCode: "TEST",
  localPlayerId: "p2",
  isHost: false,
  isDrawer: false,
  isSpectator: false,
  players: [
    {
      id: "p1",
      name: "Alice",
      score: 0,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
      isHost: true,
    },
    {
      id: "p2",
      name: "Bob",
      score: 0,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
      isHost: false,
    },
    {
      id: "p3",
      name: "Charlie",
      score: 0,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
      isHost: false,
    },
  ],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  wordChoices: [],
  currentTheme: null,
  drawingEvent: null,
  currentWord: null,
  drawerId: null,
  currentRound: 1,
  totalRounds: 3,
  timerSeconds: 80,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
  waitingForReconnect: false,
  reconnectCountdown: 0,
  activeVoteKick: null,
};

function renderBanner(overrides: Partial<GameState> = {}) {
  const send = vi.fn();
  const dispatch = vi.fn();
  const contextValue: WebSocketContextValue = {
    gameState: { ...defaultGameState, ...overrides },
    send,
    dispatch,
    isConnected: true,
    mutedPlayerIds: new Set(),
    toggleMutePlayer: vi.fn(),
  };

  const utils = render(
    <WebSocketContext.Provider value={contextValue}>
      <VoteKickBanner />
    </WebSocketContext.Provider>
  );

  return { ...utils, send, dispatch };
}

describe("VoteKickBanner", () => {
  it("renders nothing when no active vote-kick exists", () => {
    const { container } = renderBanner({ activeVoteKick: null });
    expect(container.firstChild).toBeNull();
  });

  it("renders vote-kick banner with details and buttons when vote is active", () => {
    const { send } = renderBanner({
      activeVoteKick: {
        targetId: "p3",
        targetName: "Charlie",
        initiatorId: "p1",
        initiatorName: "Alice",
        currentVotes: 1,
        requiredVotes: 2,
        timeoutSeconds: 30,
        hasVoted: false,
      },
    });

    expect(screen.getByTestId("vote-kick-banner")).toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();
    expect(screen.getByText(/Initiated by Alice/)).toBeInTheDocument();

    const yesBtn = screen.getByTestId("vote-kick-yes-btn");
    const noBtn = screen.getByTestId("vote-kick-no-btn");
    expect(yesBtn).toBeInTheDocument();
    expect(noBtn).toBeInTheDocument();

    fireEvent.click(yesBtn);
    expect(send).toHaveBeenCalledWith("vote_kick_cast", { vote: true });

    fireEvent.click(noBtn);
    expect(send).toHaveBeenCalledWith("vote_kick_cast", { vote: false });
  });

  it("shows target message if local player is the target", () => {
    renderBanner({
      localPlayerId: "p3",
      activeVoteKick: {
        targetId: "p3",
        targetName: "Charlie",
        initiatorId: "p1",
        initiatorName: "Alice",
        currentVotes: 1,
        requiredVotes: 2,
        timeoutSeconds: 30,
        hasVoted: false,
      },
    });

    expect(screen.getByTestId("vote-kick-target-msg")).toBeInTheDocument();
    expect(screen.queryByTestId("vote-kick-yes-btn")).not.toBeInTheDocument();
  });

  it("shows voted message if local player has already voted", () => {
    renderBanner({
      localPlayerId: "p2",
      activeVoteKick: {
        targetId: "p3",
        targetName: "Charlie",
        initiatorId: "p1",
        initiatorName: "Alice",
        currentVotes: 2,
        requiredVotes: 2,
        timeoutSeconds: 30,
        hasVoted: true,
      },
    });

    expect(screen.getByTestId("vote-kick-voted-msg")).toBeInTheDocument();
    expect(screen.queryByTestId("vote-kick-yes-btn")).not.toBeInTheDocument();
  });
});
