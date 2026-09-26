import { useRef, useEffect } from "react";
import { useCanvas } from "../hooks/useCanvas";
import { useWebSocket } from "../hooks/useWebSocket";
import type { BrushSize, DrawingAction } from "../hooks/useCanvas";
import { subscribeDrawing } from "../context/drawingBus";
import RoundTransition from "./RoundTransition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanvasProps {
  isDrawer: boolean;
  showRoundTransition?: boolean;
  roundInfo?: { round: number; totalRounds: number };
  onTransitionComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  "#000000", // Black
  "#666666", // Dark Gray
  "#A3A3A3", // Light Gray
  "#FFFFFF", // White
  "#E50000", // Red
  "#FF7930", // Orange
  "#FFD700", // Gold / Yellow
  "#00C853", // Green
  "#00796B", // Teal
  "#00B0FF", // Light Blue
  "#2979FF", // Blue
  "#6200EA", // Indigo / Purple
  "#D500F9", // Magenta
  "#FF4081", // Pink
  "#795548", // Brown
  "#F5DEB3", // Beige / Tan
];

const BRUSH_SIZE_OPTIONS: { label: string; value: BrushSize }[] = [
  { label: "XS", value: "xs" },
  { label: "S", value: "small" },
  { label: "M", value: "medium" },
  { label: "L", value: "large" },
  { label: "XL", value: "xl" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Canvas({
  isDrawer,
  showRoundTransition,
  roundInfo,
  onTransitionComplete,
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { send } = useWebSocket();
  const {
    color,
    setColor,
    brushSize,
    setBrushSize,
    tool,
    setTool,
    clearCanvas,
    undo,
    redo,
    canUndo,
    canRedo,
    renderRemoteStroke,
    renderRemoteFill,
    renderRemoteUndo,
  } = useCanvas(canvasRef, isDrawer);

  // Initialize canvas with white background on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  // Subscribe to incoming drawing events from the server. Rendering happens the
  // instant each event arrives (see drawingBus) so no segment is lost to React
  // batching — the cause of the dashed/broken remote drawings.
  useEffect(() => {
    const unsubscribe = subscribeDrawing((event) => {
      const { type, payload } = event;
      if (type === "stroke" && payload) {
        const p = payload as { points: [number, number][]; color: string; size: number };
        renderRemoteStroke(p);
      } else if (type === "fill" && payload) {
        const p = payload as { x: number; y: number; color: string };
        renderRemoteFill(p);
      } else if (type === "clear_canvas") {
        clearCanvas();
      } else if (type === "undo") {
        const p = payload as { actions?: DrawingAction[] } | undefined;
        renderRemoteUndo(p?.actions);
      }
    });
    return unsubscribe;
  }, [renderRemoteStroke, renderRemoteFill, clearCanvas, renderRemoteUndo]);

  // Expose render methods on the canvas element for parent access
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    (canvas as unknown as Record<string, unknown>).__renderRemoteStroke = renderRemoteStroke;
    (canvas as unknown as Record<string, unknown>).__renderRemoteFill = renderRemoteFill;
    (canvas as unknown as Record<string, unknown>).__renderRemoteUndo = renderRemoteUndo;
    (canvas as unknown as Record<string, unknown>).__clearCanvas = clearCanvas;
  }, [renderRemoteStroke, renderRemoteFill, renderRemoteUndo, clearCanvas]);

  const handleClear = () => {
    clearCanvas();
    send("clear_canvas");
  };

  return (
    <div className="canvas-container" data-testid="canvas-container">
      <div
        className="canvas-wrapper"
        style={{
          position: "relative",
          overflow: "hidden",
          display: "inline-block",
          width: "100%",
          maxWidth: 800,
          touchAction: "none",
        }}
      >
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          data-testid="drawing-canvas"
          style={{
            display: "block",
            width: "100%",
            height: "auto",
            aspectRatio: "4 / 3",
            border: "2px solid #333",
            borderRadius: "var(--radius-md, 8px)",
            cursor: isDrawer ? "crosshair" : "default",
            touchAction: "none",
          }}
        />
        {showRoundTransition && roundInfo && (
          <RoundTransition
            round={roundInfo.round}
            totalRounds={roundInfo.totalRounds}
            show={showRoundTransition}
            onComplete={onTransitionComplete ?? (() => {})}
          />
        )}
      </div>
      {isDrawer && (
        <div
          className="drawing-toolbar"
          data-testid="drawing-toolbar"
          role="toolbar"
          aria-label="Drawing tools"
        >
          {/* Color Picker */}
          <div className="toolbar-section" data-testid="color-picker">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                data-testid={`color-${c}`}
                onClick={() => setColor(c)}
                style={{
                  width: 28,
                  height: 28,
                  backgroundColor: c,
                  border: color === c ? "3px solid #333" : "1px solid #ccc",
                  borderRadius: 4,
                  cursor: "pointer",
                  margin: 2,
                }}
              />
            ))}
          </div>

          {/* Brush Size Selector */}
          <div className="toolbar-section" data-testid="brush-size-selector">
            {BRUSH_SIZE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-label={`Brush size ${opt.value}`}
                data-testid={`brush-${opt.value}`}
                onClick={() => setBrushSize(opt.value)}
                style={{
                  padding: "4px 10px",
                  border: brushSize === opt.value ? "2px solid #333" : "1px solid #ccc",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontWeight: brushSize === opt.value ? "bold" : "normal",
                  margin: 2,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Tool Buttons */}
          <div className="toolbar-section" data-testid="tool-buttons">
            <ToolButton
              label="Pen"
              testId="tool-pen"
              active={tool === "pen"}
              onClick={() => setTool("pen")}
            />
            <ToolButton
              label="Eraser"
              testId="tool-eraser"
              active={tool === "eraser"}
              onClick={() => setTool("eraser")}
            />
            <ToolButton
              label="Fill"
              testId="tool-fill"
              active={tool === "fill"}
              onClick={() => setTool("fill")}
            />
          </div>

          {/* Undo / Redo Buttons */}
          <div className="toolbar-section" data-testid="undo-redo-buttons">
            <button
              type="button"
              aria-label="Undo"
              data-testid="undo-btn"
              disabled={!canUndo}
              onClick={undo}
              style={{
                padding: "4px 10px",
                border: "1px solid #ccc",
                borderRadius: 4,
                cursor: canUndo ? "pointer" : "not-allowed",
                opacity: canUndo ? 1 : 0.5,
                margin: 2,
              }}
            >
              Undo
            </button>
            <button
              type="button"
              aria-label="Redo"
              data-testid="redo-btn"
              disabled={!canRedo}
              onClick={redo}
              style={{
                padding: "4px 10px",
                border: "1px solid #ccc",
                borderRadius: 4,
                cursor: canRedo ? "pointer" : "not-allowed",
                opacity: canRedo ? 1 : 0.5,
                margin: 2,
              }}
            >
              Redo
            </button>
          </div>

          {/* Clear Canvas Button */}
          <div className="toolbar-section">
            <ClearButton onClear={handleClear} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolButton({
  label,
  testId,
  active,
  onClick,
}: {
  label: string;
  testId: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      style={{
        padding: "4px 12px",
        border: active ? "2px solid #333" : "1px solid #ccc",
        borderRadius: 4,
        cursor: "pointer",
        fontWeight: active ? "bold" : "normal",
        margin: 2,
      }}
    >
      {label}
    </button>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      aria-label="Clear canvas"
      data-testid="clear-canvas-btn"
      onClick={onClear}
      style={{
        padding: "4px 12px",
        border: "1px solid #ccc",
        borderRadius: 4,
        cursor: "pointer",
        margin: 2,
        backgroundColor: "#ff4444",
        color: "white",
      }}
    >
      Clear
    </button>
  );
}
