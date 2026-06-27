import { useRef, useEffect } from "react";
import { useCanvas } from "../hooks/useCanvas";
import { useWebSocket } from "../hooks/useWebSocket";
import type { BrushSize } from "../hooks/useCanvas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanvasProps {
  isDrawer: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  "#000000", // Black
  "#FFFFFF", // White
  "#FF0000", // Red
  "#00FF00", // Green
  "#0000FF", // Blue
  "#FFFF00", // Yellow
  "#FF8000", // Orange
  "#800080", // Purple
  "#00FFFF", // Cyan
  "#FF69B4", // Pink
];

const BRUSH_SIZE_OPTIONS: { label: string; value: BrushSize }[] = [
  { label: "S", value: "small" },
  { label: "M", value: "medium" },
  { label: "L", value: "large" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Canvas({ isDrawer }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { send, gameState } = useWebSocket();
  const {
    color,
    setColor,
    brushSize,
    setBrushSize,
    tool,
    setTool,
    clearCanvas,
    renderRemoteStroke,
    renderRemoteFill,
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

  // Handle incoming drawing events from the server
  useEffect(() => {
    if (!gameState.drawingEvent) return;
    const { type, payload } = gameState.drawingEvent;
    if (type === "stroke" && payload) {
      const p = payload as { points: [number, number][]; color: string; size: number };
      renderRemoteStroke(p);
    } else if (type === "fill" && payload) {
      const p = payload as { x: number; y: number; color: string };
      renderRemoteFill(p);
    } else if (type === "clear_canvas") {
      clearCanvas();
    }
  }, [gameState.drawingEvent, renderRemoteStroke, renderRemoteFill, clearCanvas]);

  // Expose render methods for incoming server events via a ref-based approach
  // The parent Game page will call these when receiving stroke/fill/clear events
  // We attach them to the canvas element's dataset for access, or expose via useEffect
  const renderMethodsRef = useRef({ renderRemoteStroke, renderRemoteFill, clearCanvas });
  useEffect(() => {
    renderMethodsRef.current = { renderRemoteStroke, renderRemoteFill, clearCanvas };
  }, [renderRemoteStroke, renderRemoteFill, clearCanvas]);

  // Expose render methods on the canvas element for parent access
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Attach methods as custom properties on the DOM element
    (canvas as unknown as Record<string, unknown>).__renderRemoteStroke = renderRemoteStroke;
    (canvas as unknown as Record<string, unknown>).__renderRemoteFill = renderRemoteFill;
    (canvas as unknown as Record<string, unknown>).__clearCanvas = clearCanvas;
  }, [renderRemoteStroke, renderRemoteFill, clearCanvas]);

  const handleClear = () => {
    clearCanvas();
    send("clear_canvas");
  };

  return (
    <div className="canvas-container" data-testid="canvas-container">
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        data-testid="drawing-canvas"
        style={{
          border: "2px solid #333",
          cursor: isDrawer ? "crosshair" : "default",
          touchAction: "none",
        }}
      />
      {isDrawer && (
        <div className="drawing-toolbar" data-testid="drawing-toolbar" role="toolbar" aria-label="Drawing tools">
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
