import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState, ChatMessage } from "../types";
import Chat from "../components/Chat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultGameState: GameState = {
  phase: "playing",
  roomCode: "ABC123",
  localPlayerId: "player-1",
  isHost: false,
  isDrawer: false,
  players: [],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  currentRound: 1,
  totalRounds: 3,
  timerSeconds: 60,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
};

function renderChat(overrides: Partial<GameState> = {}) {
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
      <Chat />
    </WebSocketContext.Provider>
  );

  return { ...utils, send, dispatch };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat Component", () => {
  describe("Input disabled state (Requirement 6.1, 6.4)", () => {
    it("enables input when isDrawer is true (drawer can chat)", () => {
      renderChat({ isDrawer: true });
      const input = screen.getByTestId("chat-input");
      expect(input).not.toBeDisabled();
    });

    it("disables input when hasGuessed is true", () => {
      renderChat({ hasGuessed: true });
      const input = screen.getByTestId("chat-input");
      expect(input).toBeDisabled();
    });

    it("enables input when player is a guesser who has not guessed", () => {
      renderChat({ isDrawer: false, hasGuessed: false });
      const input = screen.getByTestId("chat-input");
      expect(input).not.toBeDisabled();
    });
  });

  describe("Correct-guess messages styling (Requirement 12.8)", () => {
    it("applies distinct CSS class for correct_guess messages", () => {
      const messages: ChatMessage[] = [
        {
          id: "msg-1",
          senderId: "player-2",
          senderName: "Bob",
          text: "Bob guessed the word!",
          type: "correct_guess",
        },
      ];
      renderChat({ chatMessages: messages });
      const msgEl = screen.getByTestId("chat-msg-correct_guess");
      expect(msgEl).toHaveClass("chat-correct-guess");
    });

    it("applies distinct CSS class for system messages", () => {
      const messages: ChatMessage[] = [
        {
          id: "msg-2",
          senderId: "system",
          senderName: "System",
          text: "A new round has started!",
          type: "system",
        },
      ];
      renderChat({ chatMessages: messages });
      const msgEl = screen.getByTestId("chat-msg-system");
      expect(msgEl).toHaveClass("chat-system");
    });

    it("renders chat messages without the special classes", () => {
      const messages: ChatMessage[] = [
        {
          id: "msg-3",
          senderId: "player-1",
          senderName: "Alice",
          text: "Hello!",
          type: "chat",
        },
      ];
      renderChat({ chatMessages: messages });
      const msgEl = screen.getByTestId("chat-msg-chat");
      expect(msgEl).toHaveClass("chat-message");
      expect(msgEl).not.toHaveClass("chat-correct-guess");
      expect(msgEl).not.toHaveClass("chat-system");
    });
  });
});
