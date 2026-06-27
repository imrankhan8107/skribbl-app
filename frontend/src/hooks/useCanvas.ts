import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./useWebSocket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrawingTool = "pen" | "fill" | "eraser";
export type BrushSize = "small" | "medium" | "large";

export interface UseCanvasReturn {
  color: string;
  setColor: (color: string) => void;
  brushSize: BrushSize;
  setBrushSize: (size: BrushSize) => void;
  tool: DrawingTool;
  setTool: (tool: DrawingTool) => void;
  clearCanvas: () => void;
  renderRemoteStroke: (stroke: {
    points: [number, number][];
    color: string;
    size: number;
  }) => void;
  renderRemoteFill: (fill: { x: number; y: number; color: string }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_BG = "#FFFFFF";

const BRUSH_SIZES: Record<BrushSize, number> = {
  small: 4,
  medium: 8,
  large: 16,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement>,
  isDrawer: boolean
): UseCanvasReturn {
  const { send } = useWebSocket();

  const [color, setColor] = useState<string>("#000000");
  const [brushSize, setBrushSize] = useState<BrushSize>("medium");
  const [tool, setTool] = useState<DrawingTool>("pen");

  // Drawing state (mutable refs to avoid re-renders on each event)
  const isDrawingRef = useRef(false);
  const pointsRef = useRef<[number, number][]>([]);

  // Keep refs to current tool state for use in event handlers
  const colorRef = useRef(color);
  const brushSizeRef = useRef(brushSize);
  const toolRef = useRef(tool);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);
  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  // ---------------------------------------------------------------------------
  // Helper: get 2D context
  // ---------------------------------------------------------------------------
  const getCtx = useCallback((): CanvasRenderingContext2D | null => {
    return canvasRef.current?.getContext("2d") ?? null;
  }, [canvasRef]);

  // ---------------------------------------------------------------------------
  // Helper: get canvas-relative coordinates
  // ---------------------------------------------------------------------------
  const getCanvasCoords = useCallback(
    (e: MouseEvent | Touch): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [0, 0];
      const rect = canvas.getBoundingClientRect();
      // Scale from CSS display size to internal canvas resolution
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      return [x, y];
    },
    [canvasRef]
  );

  // ---------------------------------------------------------------------------
  // Draw a stroke on the canvas (local or remote)
  // ---------------------------------------------------------------------------
  const drawStroke = useCallback(
    (points: [number, number][], strokeColor: string, size: number) => {
      const ctx = getCtx();
      if (!ctx || points.length === 0) return;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = size;

      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      if (points.length === 1) {
        // Single dot
        ctx.lineTo(points[0][0] + 0.1, points[0][1] + 0.1);
      }
      ctx.stroke();
    },
    [getCtx]
  );

  // ---------------------------------------------------------------------------
  // Flood fill (BFS on pixel data)
  // ---------------------------------------------------------------------------
  const floodFill = useCallback(
    (startX: number, startY: number, fillColor: string) => {
      const canvas = canvasRef.current;
      const ctx = getCtx();
      if (!canvas || !ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;

      // Parse fill color to RGBA
      const fillRGBA = hexToRGBA(fillColor);

      const sx = Math.floor(startX);
      const sy = Math.floor(startY);
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;

      const startIdx = (sy * width + sx) * 4;
      const targetR = data[startIdx];
      const targetG = data[startIdx + 1];
      const targetB = data[startIdx + 2];
      const targetA = data[startIdx + 3];

      // If the target color is the same as fill color, no-op
      if (
        targetR === fillRGBA[0] &&
        targetG === fillRGBA[1] &&
        targetB === fillRGBA[2] &&
        targetA === fillRGBA[3]
      ) {
        return;
      }

      const tolerance = 10;

      const matchesTarget = (idx: number): boolean => {
        return (
          Math.abs(data[idx] - targetR) <= tolerance &&
          Math.abs(data[idx + 1] - targetG) <= tolerance &&
          Math.abs(data[idx + 2] - targetB) <= tolerance &&
          Math.abs(data[idx + 3] - targetA) <= tolerance
        );
      };

      const setPixel = (idx: number) => {
        data[idx] = fillRGBA[0];
        data[idx + 1] = fillRGBA[1];
        data[idx + 2] = fillRGBA[2];
        data[idx + 3] = fillRGBA[3];
      };

      // BFS
      const queue: [number, number][] = [[sx, sy]];
      const visited = new Uint8Array(width * height);
      visited[sy * width + sx] = 1;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift()!;
        const idx = (cy * width + cx) * 4;

        if (!matchesTarget(idx)) continue;
        setPixel(idx);

        const neighbors: [number, number][] = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx]) {
              visited[nIdx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);
    },
    [canvasRef, getCtx]
  );

  // ---------------------------------------------------------------------------
  // Clear canvas
  // ---------------------------------------------------------------------------
  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = getCtx();
    if (!canvas || !ctx) return;
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [canvasRef, getCtx]);

  // ---------------------------------------------------------------------------
  // Render remote stroke
  // ---------------------------------------------------------------------------
  const renderRemoteStroke = useCallback(
    (stroke: { points: [number, number][]; color: string; size: number }) => {
      drawStroke(stroke.points, stroke.color, stroke.size);
    },
    [drawStroke]
  );

  // ---------------------------------------------------------------------------
  // Render remote fill
  // ---------------------------------------------------------------------------
  const renderRemoteFill = useCallback(
    (fill: { x: number; y: number; color: string }) => {
      floodFill(fill.x, fill.y, fill.color);
    },
    [floodFill]
  );

  // ---------------------------------------------------------------------------
  // Pointer event handlers (attached only when isDrawer is true)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isDrawer) return;

    const handlePointerDown = (e: MouseEvent) => {
      e.preventDefault();
      const currentTool = toolRef.current;

      if (currentTool === "fill") {
        const [x, y] = getCanvasCoords(e);
        const fillColor = colorRef.current;
        floodFill(x, y, fillColor);
        send("fill", { x, y, color: fillColor });
        return;
      }

      isDrawingRef.current = true;
      const [x, y] = getCanvasCoords(e);
      pointsRef.current = [[x, y]];

      // Send the starting point immediately
      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      send("stroke", { points: [[x, y]], color: strokeColor, size });
    };

    const handlePointerMove = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      const [x, y] = getCanvasCoords(e);
      pointsRef.current.push([x, y]);

      // Draw intermediate stroke for immediate visual feedback
      const currentTool = toolRef.current;
      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      const points = pointsRef.current;
      if (points.length >= 2) {
        drawStroke(
          [points[points.length - 2], points[points.length - 1]],
          strokeColor,
          size
        );
      }

      // Stream each segment to the server in real-time
      if (points.length >= 2) {
        send("stroke", {
          points: [points[points.length - 2], points[points.length - 1]],
          color: strokeColor,
          size,
        });
      }
    };

    const handlePointerUp = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;

      const currentTool = toolRef.current;
      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      const points = pointsRef.current;

      if (points.length === 1) {
        // Single dot — already sent on pointerdown
        drawStroke(points, strokeColor, size);
      }

      pointsRef.current = [];
    };

    // Touch equivalents
    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent("mousedown", {
          clientX: touch.clientX,
          clientY: touch.clientY,
        });
        handlePointerDown(mouseEvent);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent("mousemove", {
          clientX: touch.clientX,
          clientY: touch.clientY,
        });
        handlePointerMove(mouseEvent);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      const mouseEvent = new MouseEvent("mouseup", {
        clientX: 0,
        clientY: 0,
      });
      handlePointerUp(mouseEvent);
    };

    canvas.addEventListener("mousedown", handlePointerDown);
    canvas.addEventListener("mousemove", handlePointerMove);
    canvas.addEventListener("mouseup", handlePointerUp);
    canvas.addEventListener("mouseleave", handlePointerUp);
    canvas.addEventListener("touchstart", handleTouchStart);
    canvas.addEventListener("touchmove", handleTouchMove);
    canvas.addEventListener("touchend", handleTouchEnd);

    return () => {
      canvas.removeEventListener("mousedown", handlePointerDown);
      canvas.removeEventListener("mousemove", handlePointerMove);
      canvas.removeEventListener("mouseup", handlePointerUp);
      canvas.removeEventListener("mouseleave", handlePointerUp);
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
    };
  }, [canvasRef, isDrawer, getCanvasCoords, floodFill, drawStroke, send]);

  return {
    color,
    setColor,
    brushSize,
    setBrushSize,
    tool,
    setTool,
    clearCanvas,
    renderRemoteStroke,
    renderRemoteFill,
  };
}

// ---------------------------------------------------------------------------
// Utility: hex color to RGBA array
// ---------------------------------------------------------------------------

function hexToRGBA(hex: string): [number, number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b, 255];
}
