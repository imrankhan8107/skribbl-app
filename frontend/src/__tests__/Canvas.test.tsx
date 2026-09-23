import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebSocketContext } from "../context/WebSocketContext";
import type { WebSocketContextValue } from "../context/WebSocketContext";
import type { GameState } from "../types";
import Canvas from "../components/Canvas";

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
  // Mock HTMLCanvasElement.prototype.getContext
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => mockCtx as unknown as CanvasRenderingContext2D
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultGameState: GameState = {
  phase: "playing",
  roomCode: "ABC123",
  localPlayerId: "player-1",
  isHost: false,
  isDrawer: true,
  players: [],
  config: { numRounds: 3, turnDuration: 80, maxPlayers: 8 },
  hint: [],
  wordChoices: [],
  drawingEvent: null,
  currentWord: null,
  drawerId: null,
  currentRound: 1,
  totalRounds: 3,
  timerSeconds: 60,
  hasGuessed: false,
  errorMessage: null,
  chatMessages: [],
  waitingForReconnect: false,
  reconnectCountdown: 0,
};

function renderCanvas(isDrawer: boolean, overrides: Partial<WebSocketContextValue> = {}) {
  const send = vi.fn();
  const contextValue: WebSocketContextValue = {
    gameState: { ...defaultGameState, isDrawer },
    send,
    dispatch: vi.fn(),
    isConnected: true,
    ...overrides,
  };

  const utils = render(
    <WebSocketContext.Provider value={contextValue}>
      <Canvas isDrawer={isDrawer} />
    </WebSocketContext.Provider>
  );

  return { ...utils, send, contextValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Canvas", () => {
  describe("Toolbar visibility (Requirement 5.9)", () => {
    it("hides toolbar when isDrawer is false", () => {
      renderCanvas(false);
      expect(screen.queryByTestId("drawing-toolbar")).not.toBeInTheDocument();
    });

    it("shows toolbar when isDrawer is true", () => {
      renderCanvas(true);
      expect(screen.getByTestId("drawing-toolbar")).toBeInTheDocument();
    });
  });

  describe("Send stroke on pointer drag (Requirement 5.1)", () => {
    it("calls send('stroke', ...) on pointer drag when isDrawer is true", () => {
      const { send } = renderCanvas(true);
      const canvas = screen.getByTestId("drawing-canvas");

      // Simulate mousedown → mousemove → mouseup (a pointer drag)
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(canvas, { clientX: 110, clientY: 110 });
      fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
      fireEvent.mouseUp(canvas, { clientX: 120, clientY: 120 });

      expect(send).toHaveBeenCalledWith(
        "stroke",
        expect.objectContaining({
          points: expect.any(Array),
          color: expect.any(String),
          size: expect.any(Number),
        })
      );
    });

    it("does NOT call send on pointer drag when isDrawer is false", () => {
      const { send } = renderCanvas(false);
      const canvas = screen.getByTestId("drawing-canvas");

      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(canvas, { clientX: 110, clientY: 110 });
      fireEvent.mouseUp(canvas, { clientX: 120, clientY: 120 });

      expect(send).not.toHaveBeenCalledWith("stroke", expect.anything());
    });
  });

  describe("Clear canvas button (Requirement 5.8, 12.9)", () => {
    it("calls send('clear_canvas') when clear button is clicked", async () => {
      const user = userEvent.setup();
      const { send } = renderCanvas(true);

      const clearBtn = screen.getByTestId("clear-canvas-btn");
      await user.click(clearBtn);

      expect(send).toHaveBeenCalledWith("clear_canvas");
    });
  });

  describe("Drawing toolbar contents (Requirement 5.4, 5.5)", () => {
    it("renders 16 color options", () => {
      renderCanvas(true);
      const colorPicker = screen.getByTestId("color-picker");
      const colorButtons = colorPicker.querySelectorAll("button");
      expect(colorButtons.length).toBe(16);
    });

    it("renders 5 brush size options (xs, small, medium, large, xl)", () => {
      renderCanvas(true);
      expect(screen.getByTestId("brush-xs")).toBeInTheDocument();
      expect(screen.getByTestId("brush-small")).toBeInTheDocument();
      expect(screen.getByTestId("brush-medium")).toBeInTheDocument();
      expect(screen.getByTestId("brush-large")).toBeInTheDocument();
      expect(screen.getByTestId("brush-xl")).toBeInTheDocument();
    });

    it("renders eraser button", () => {
      renderCanvas(true);
      expect(screen.getByTestId("tool-eraser")).toBeInTheDocument();
    });

    it("renders fill tool button", () => {
      renderCanvas(true);
      expect(screen.getByTestId("tool-fill")).toBeInTheDocument();
    });

    it("renders undo and redo buttons with correct initial disabled state", () => {
      renderCanvas(true);
      const undoBtn = screen.getByTestId("undo-btn");
      const redoBtn = screen.getByTestId("redo-btn");
      expect(undoBtn).toBeDisabled();
      expect(redoBtn).toBeDisabled();
    });

    it("enables undo after drawing a stroke and sends undo on click", async () => {
      const user = userEvent.setup();
      const { send } = renderCanvas(true);
      const canvas = screen.getByTestId("drawing-canvas");

      // Draw a stroke
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(canvas, { clientX: 110, clientY: 110 });
      fireEvent.mouseUp(canvas, { clientX: 110, clientY: 110 });

      const undoBtn = screen.getByTestId("undo-btn");
      expect(undoBtn).not.toBeDisabled();

      await user.click(undoBtn);
      expect(send).toHaveBeenCalledWith(
        "undo",
        expect.objectContaining({ actions: expect.any(Array) })
      );

      // After undo, redo should now be enabled
      const redoBtn = screen.getByTestId("redo-btn");
      expect(redoBtn).not.toBeDisabled();
    });

    it("supports Ctrl+Z keyboard shortcut for undo", () => {
      const { send } = renderCanvas(true);
      const canvas = screen.getByTestId("drawing-canvas");

      // Draw a stroke
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(canvas, { clientX: 110, clientY: 110 });
      fireEvent.mouseUp(canvas, { clientX: 110, clientY: 110 });

      // Trigger Ctrl+Z
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      expect(send).toHaveBeenCalledWith(
        "undo",
        expect.objectContaining({ actions: expect.any(Array) })
      );
    });
  });
});
