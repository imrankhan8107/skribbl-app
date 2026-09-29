import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./useWebSocket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrawingTool = "pen" | "highlighter" | "eraser" | "fill" | "line" | "rect" | "circle";
export type BrushSize = "xs" | "small" | "medium" | "large" | "xl";

import type { DrawingAction } from "../types";
import { getConstrainedEnd, type ConstrainableShape } from "../utils/shapeSnap";
export type { DrawingAction };

export interface UseCanvasReturn {
  color: string;
  setColor: (color: string) => void;
  brushSize: BrushSize;
  setBrushSize: (size: BrushSize) => void;
  tool: DrawingTool;
  setTool: (tool: DrawingTool) => void;
  clearCanvas: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSnapActive: boolean;
  snapToggled: boolean;
  setSnapToggled: (val: boolean | ((prev: boolean) => boolean)) => void;
  renderRemoteStroke: (stroke: { points: [number, number][]; color: string; size: number }) => void;
  renderRemoteHighlighter: (highlighter: {
    points: [number, number][];
    color: string;
    size: number;
  }) => void;
  renderRemoteShape: (shape: {
    shapeType: "line" | "rect" | "circle";
    start: [number, number];
    end: [number, number];
    color: string;
    size: number;
  }) => void;
  renderRemoteFill: (fill: { x: number; y: number; color: string }) => void;
  renderRemoteUndo: (actions?: DrawingAction[]) => void;
  getHistory: () => DrawingAction[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_BG = "#FFFFFF";

export const BRUSH_SIZES: Record<BrushSize, number> = {
  xs: 2,
  small: 4,
  medium: 8,
  large: 16,
  xl: 32,
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
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [snapToggled, setSnapToggled] = useState(false);

  // Drawing state (mutable refs to avoid re-renders on each event)
  const isDrawingRef = useRef(false);
  const pointsRef = useRef<[number, number][]>([]);

  // Shape dragging preview state
  const shapeStartRef = useRef<[number, number] | null>(null);
  const shapeSnapshotRef = useRef<ImageData | null>(null);
  const lastCoordsRef = useRef<[number, number] | null>(null);
  const isShiftPressedRef = useRef(false);
  const snapToggledRef = useRef(false);

  // Action history for undo/redo
  const actionHistoryRef = useRef<DrawingAction[]>([]);
  const redoStackRef = useRef<DrawingAction[]>([]);

  // Keep refs to current tool state for use in event handlers
  const colorRef = useRef(color);
  const brushSizeRef = useRef(brushSize);
  const toolRef = useRef(tool);

  // 60 FPS (16ms) Stroke Point Batching
  // Avoids blasting 120-140 WebSocket messages/sec over high-latency networks.
  // Batches intermediate points into clean 60fps chunks while keeping local
  // drawing completely instant.
  const pendingStrokePointsRef = useRef<[number, number][]>([]);
  const lastDispatchedPointRef = useRef<[number, number] | null>(null);
  const strokeBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);
  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    snapToggledRef.current = snapToggled;
  }, [snapToggled]);

  // Reset undo/redo when drawer role changes
  useEffect(() => {
    if (!isDrawer) {
      actionHistoryRef.current = [];
      redoStackRef.current = [];
      setCanUndo(false);
      setCanRedo(false);
    }
  }, [isDrawer]);

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
      if (points.length === 1) {
        // Single dot
        ctx.lineTo(points[0][0] + 0.1, points[0][1] + 0.1);
      } else if (points.length === 2) {
        ctx.lineTo(points[1][0], points[1][1]);
      } else {
        // Quadratic Bézier curve smoothing through midpoints
        let p1 = points[0];
        let p2 = points[1];
        let midX = (p1[0] + p2[0]) / 2;
        let midY = (p1[1] + p2[1]) / 2;
        ctx.lineTo(midX, midY);

        for (let i = 1; i < points.length - 1; i++) {
          p1 = points[i];
          p2 = points[i + 1];
          const nextMidX = (p1[0] + p2[0]) / 2;
          const nextMidY = (p1[1] + p2[1]) / 2;
          if (typeof ctx.quadraticCurveTo === "function") {
            ctx.quadraticCurveTo(p1[0], p1[1], nextMidX, nextMidY);
          } else {
            ctx.lineTo(p1[0], p1[1]);
          }
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
      }
      ctx.stroke();
    },
    [getCtx]
  );

  // ---------------------------------------------------------------------------
  // Draw highlighter stroke (semi-transparent, wide)
  // ---------------------------------------------------------------------------
  const drawHighlighter = useCallback(
    (points: [number, number][], strokeColor: string, size: number) => {
      const ctx = getCtx();
      if (!ctx || points.length === 0) return;

      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = size * 2.5;

      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      if (points.length === 1) {
        ctx.lineTo(points[0][0] + 0.1, points[0][1] + 0.1);
      } else if (points.length === 2) {
        ctx.lineTo(points[1][0], points[1][1]);
      } else {
        let p1 = points[0];
        let p2 = points[1];
        let midX = (p1[0] + p2[0]) / 2;
        let midY = (p1[1] + p2[1]) / 2;
        ctx.lineTo(midX, midY);

        for (let i = 1; i < points.length - 1; i++) {
          p1 = points[i];
          p2 = points[i + 1];
          const nextMidX = (p1[0] + p2[0]) / 2;
          const nextMidY = (p1[1] + p2[1]) / 2;
          if (typeof ctx.quadraticCurveTo === "function") {
            ctx.quadraticCurveTo(p1[0], p1[1], nextMidX, nextMidY);
          } else {
            ctx.lineTo(p1[0], p1[1]);
          }
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
      }
      ctx.stroke();
      ctx.restore();
    },
    [getCtx]
  );

  // ---------------------------------------------------------------------------
  // Draw straight line
  // ---------------------------------------------------------------------------
  const drawLine = useCallback(
    (start: [number, number], end: [number, number], strokeColor: string, size: number) => {
      const ctx = getCtx();
      if (!ctx) return;

      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = size;

      ctx.beginPath();
      ctx.moveTo(start[0], start[1]);
      ctx.lineTo(end[0], end[1]);
      ctx.stroke();
      ctx.restore();
    },
    [getCtx]
  );

  // ---------------------------------------------------------------------------
  // Draw rectangle
  // ---------------------------------------------------------------------------
  const drawRect = useCallback(
    (start: [number, number], end: [number, number], strokeColor: string, size: number) => {
      const ctx = getCtx();
      if (!ctx) return;

      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = size;
      ctx.lineJoin = "miter";

      const x = Math.min(start[0], end[0]);
      const y = Math.min(start[1], end[1]);
      const w = Math.abs(end[0] - start[0]);
      const h = Math.abs(end[1] - start[1]);

      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    },
    [getCtx]
  );

  // ---------------------------------------------------------------------------
  // Draw circle / ellipse
  // ---------------------------------------------------------------------------
  const drawCircle = useCallback(
    (start: [number, number], end: [number, number], strokeColor: string, size: number) => {
      const ctx = getCtx();
      if (!ctx) return;

      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = size;

      const rx = Math.abs(end[0] - start[0]) / 2;
      const ry = Math.abs(end[1] - start[1]) / 2;
      const cx = Math.min(start[0], end[0]) + rx;
      const cy = Math.min(start[1], end[1]) + ry;

      ctx.beginPath();
      if (typeof ctx.ellipse === "function") {
        ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
      } else {
        ctx.arc(cx, cy, Math.max(rx, ry, 0.1), 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.restore();
    },
    [getCtx]
  );

  // ---------------------------------------------------------------------------
  // Update Shape Preview (used during mouse/touch move and Shift key toggle)
  // ---------------------------------------------------------------------------
  const updateShapePreview = useCallback(
    (currentPos: [number, number], snapped: boolean) => {
      if (!shapeStartRef.current) return;
      const ctx = getCtx();
      const canvas = canvasRef.current;
      if (!ctx || !canvas) return;
      if (shapeSnapshotRef.current) {
        ctx.putImageData(shapeSnapshotRef.current, 0, 0);
      }
      const currentTool = toolRef.current;
      const strokeColor = colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      const end = snapped
        ? getConstrainedEnd(shapeStartRef.current, currentPos, currentTool as ConstrainableShape)
        : currentPos;

      if (currentTool === "line") {
        drawLine(shapeStartRef.current, end, strokeColor, size);
      } else if (currentTool === "rect") {
        drawRect(shapeStartRef.current, end, strokeColor, size);
      } else if (currentTool === "circle") {
        drawCircle(shapeStartRef.current, end, strokeColor, size);
      }
    },
    [getCtx, canvasRef, drawLine, drawRect, drawCircle]
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
  // Replay actions (redraw from scratch)
  // ---------------------------------------------------------------------------
  const replayActions = useCallback(
    (actions: DrawingAction[]) => {
      const canvas = canvasRef.current;
      const ctx = getCtx();
      if (!canvas || !ctx) return;
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const action of actions) {
        if (action.type === "stroke") {
          drawStroke(action.points, action.color, action.size);
        } else if (action.type === "highlighter") {
          drawHighlighter(action.points, action.color, action.size);
        } else if (action.type === "line") {
          drawLine(action.start, action.end, action.color, action.size);
        } else if (action.type === "rect") {
          drawRect(action.start, action.end, action.color, action.size);
        } else if (action.type === "circle") {
          drawCircle(action.start, action.end, action.color, action.size);
        } else if (action.type === "fill") {
          floodFill(action.x, action.y, action.color);
        }
      }
    },
    [canvasRef, getCtx, drawStroke, drawHighlighter, drawLine, drawRect, drawCircle, floodFill]
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
    actionHistoryRef.current = [];
    redoStackRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }, [canvasRef, getCtx]);

  // ---------------------------------------------------------------------------
  // Undo & Redo (Drawer actions)
  // ---------------------------------------------------------------------------
  const undo = useCallback(() => {
    if (!isDrawer || actionHistoryRef.current.length === 0) return;
    const popped = actionHistoryRef.current.pop();
    if (popped) {
      redoStackRef.current.push(popped);
    }
    replayActions(actionHistoryRef.current);
    setCanUndo(actionHistoryRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
    send("undo", { actions: actionHistoryRef.current });
  }, [isDrawer, replayActions, send]);

  const redo = useCallback(() => {
    if (!isDrawer || redoStackRef.current.length === 0) return;
    const action = redoStackRef.current.pop();
    if (!action) return;
    actionHistoryRef.current.push(action);
    if (action.type === "stroke") {
      drawStroke(action.points, action.color, action.size);
      send("stroke", {
        points: action.points,
        color: action.color,
        size: action.size,
      });
    } else if (action.type === "highlighter") {
      drawHighlighter(action.points, action.color, action.size);
      send("highlighter", {
        points: action.points,
        color: action.color,
        size: action.size,
      });
    } else if (action.type === "line" || action.type === "rect" || action.type === "circle") {
      if (action.type === "line") drawLine(action.start, action.end, action.color, action.size);
      else if (action.type === "rect")
        drawRect(action.start, action.end, action.color, action.size);
      else if (action.type === "circle")
        drawCircle(action.start, action.end, action.color, action.size);
      send("shape", {
        shapeType: action.type,
        start: action.start,
        end: action.end,
        color: action.color,
        size: action.size,
      });
    } else if (action.type === "fill") {
      floodFill(action.x, action.y, action.color);
      send("fill", {
        x: action.x,
        y: action.y,
        color: action.color,
      });
    }
    setCanUndo(actionHistoryRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, [isDrawer, drawStroke, drawHighlighter, drawLine, drawRect, drawCircle, floodFill, send]);

  // ---------------------------------------------------------------------------
  // Render remote stroke (only for guessers/spectators; drawer already drew locally)
  // ---------------------------------------------------------------------------
  const renderRemoteStroke = useCallback(
    (stroke: { points: [number, number][]; color: string; size: number }) => {
      if (isDrawer) return;
      drawStroke(stroke.points, stroke.color, stroke.size);
      actionHistoryRef.current.push({
        type: "stroke",
        points: stroke.points,
        color: stroke.color,
        size: stroke.size,
      });
    },
    [isDrawer, drawStroke]
  );

  // ---------------------------------------------------------------------------
  // Render remote highlighter
  // ---------------------------------------------------------------------------
  const renderRemoteHighlighter = useCallback(
    (highlighter: { points: [number, number][]; color: string; size: number }) => {
      if (isDrawer) return;
      drawHighlighter(highlighter.points, highlighter.color, highlighter.size);
      actionHistoryRef.current.push({
        type: "highlighter",
        points: highlighter.points,
        color: highlighter.color,
        size: highlighter.size,
      });
    },
    [isDrawer, drawHighlighter]
  );

  // ---------------------------------------------------------------------------
  // Render remote shape
  // ---------------------------------------------------------------------------
  const renderRemoteShape = useCallback(
    (shape: {
      shapeType: "line" | "rect" | "circle";
      start: [number, number];
      end: [number, number];
      color: string;
      size: number;
    }) => {
      if (isDrawer) return;
      if (shape.shapeType === "line") {
        drawLine(shape.start, shape.end, shape.color, shape.size);
      } else if (shape.shapeType === "rect") {
        drawRect(shape.start, shape.end, shape.color, shape.size);
      } else if (shape.shapeType === "circle") {
        drawCircle(shape.start, shape.end, shape.color, shape.size);
      }
      actionHistoryRef.current.push({
        type: shape.shapeType,
        start: shape.start,
        end: shape.end,
        color: shape.color,
        size: shape.size,
      });
    },
    [isDrawer, drawLine, drawRect, drawCircle]
  );

  // ---------------------------------------------------------------------------
  // Render remote fill
  // ---------------------------------------------------------------------------
  const renderRemoteFill = useCallback(
    (fill: { x: number; y: number; color: string }) => {
      if (isDrawer) return;
      floodFill(fill.x, fill.y, fill.color);
      actionHistoryRef.current.push({
        type: "fill",
        x: fill.x,
        y: fill.y,
        color: fill.color,
      });
    },
    [isDrawer, floodFill]
  );

  // ---------------------------------------------------------------------------
  // Render remote undo
  // ---------------------------------------------------------------------------
  const renderRemoteUndo = useCallback(
    (actions?: DrawingAction[]) => {
      if (actions) {
        actionHistoryRef.current = [...actions];
        replayActions(actions);
      }
    },
    [replayActions]
  );

  const getHistory = useCallback(() => {
    return actionHistoryRef.current.slice();
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts (B=Pen, E=Eraser, F=Fill, Ctrl+Z=Undo, Ctrl+Y=Redo)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isDrawer) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      if (e.key === "Shift") {
        isShiftPressedRef.current = true;
        setIsShiftPressed(true);
        if (
          isDrawingRef.current &&
          (toolRef.current === "line" ||
            toolRef.current === "rect" ||
            toolRef.current === "circle") &&
          lastCoordsRef.current
        ) {
          updateShapePreview(lastCoordsRef.current, true);
        }
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        redo();
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "b" || key === "p") {
          setTool("pen");
        } else if (key === "h") {
          setTool("highlighter");
        } else if (key === "e") {
          setTool("eraser");
        } else if (key === "f") {
          setTool("fill");
        } else if (key === "l") {
          setTool("line");
        } else if (key === "r") {
          setTool("rect");
        } else if (key === "o" || key === "u") {
          setTool("circle");
        } else if (e.key === "[") {
          const SIZES: BrushSize[] = ["xs", "small", "medium", "large", "xl"];
          const idx = SIZES.indexOf(brushSizeRef.current);
          if (idx > 0) setBrushSize(SIZES[idx - 1]);
        } else if (e.key === "]") {
          const SIZES: BrushSize[] = ["xs", "small", "medium", "large", "xl"];
          const idx = SIZES.indexOf(brushSizeRef.current);
          if (idx < SIZES.length - 1) setBrushSize(SIZES[idx + 1]);
        } else if (key === "c") {
          clearCanvas();
          send("clear_canvas");
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        isShiftPressedRef.current = false;
        setIsShiftPressed(false);
        if (
          isDrawingRef.current &&
          (toolRef.current === "line" ||
            toolRef.current === "rect" ||
            toolRef.current === "circle") &&
          lastCoordsRef.current
        ) {
          updateShapePreview(lastCoordsRef.current, snapToggledRef.current);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isDrawer, undo, redo, clearCanvas, send, updateShapePreview]);

  // ---------------------------------------------------------------------------
  // Pointer event handlers (attached only when isDrawer is true)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isDrawer) return;

    const flushPendingStrokePoints = () => {
      if (strokeBatchTimerRef.current !== null) {
        clearTimeout(strokeBatchTimerRef.current);
        strokeBatchTimerRef.current = null;
      }

      if (pendingStrokePointsRef.current.length === 0) return;

      const currentTool = toolRef.current;
      if (currentTool !== "pen" && currentTool !== "eraser" && currentTool !== "highlighter") {
        pendingStrokePointsRef.current = [];
        return;
      }

      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];

      // Ensure the batch seamlessly connects with the previous point
      const batchPoints: [number, number][] = lastDispatchedPointRef.current
        ? [lastDispatchedPointRef.current, ...pendingStrokePointsRef.current]
        : [...pendingStrokePointsRef.current];

      lastDispatchedPointRef.current =
        pendingStrokePointsRef.current[pendingStrokePointsRef.current.length - 1];
      pendingStrokePointsRef.current = [];

      const msgType = currentTool === "highlighter" ? "highlighter" : "stroke";
      send(msgType, { points: batchPoints, color: strokeColor, size });
    };

    const handlePointerDown = (e: MouseEvent) => {
      e.preventDefault();
      const currentTool = toolRef.current;
      const [x, y] = getCanvasCoords(e);
      lastCoordsRef.current = [x, y];

      if (currentTool === "fill") {
        const fillColor = colorRef.current;
        floodFill(x, y, fillColor);
        send("fill", { x, y, color: fillColor });
        actionHistoryRef.current.push({ type: "fill", x, y, color: fillColor });
        redoStackRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
        return;
      }

      if (currentTool === "line" || currentTool === "rect" || currentTool === "circle") {
        isDrawingRef.current = true;
        shapeStartRef.current = [x, y];
        const ctx = getCtx();
        if (ctx && canvas) {
          try {
            shapeSnapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
          } catch {
            shapeSnapshotRef.current = null;
          }
        }
        return;
      }

      isDrawingRef.current = true;
      pointsRef.current = [[x, y]];
      lastDispatchedPointRef.current = [x, y];
      pendingStrokePointsRef.current = [];
      if (strokeBatchTimerRef.current !== null) {
        clearTimeout(strokeBatchTimerRef.current);
        strokeBatchTimerRef.current = null;
      }

      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];

      if (currentTool === "highlighter") {
        drawHighlighter([[x, y]], strokeColor, size);
        send("highlighter", { points: [[x, y]], color: strokeColor, size });
      } else {
        // Send the starting point immediately
        send("stroke", { points: [[x, y]], color: strokeColor, size });
      }
    };

    const handlePointerMove = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      const currentTool = toolRef.current;
      const [x, y] = getCanvasCoords(e);
      lastCoordsRef.current = [x, y];

      if (currentTool === "line" || currentTool === "rect" || currentTool === "circle") {
        const isSnapped = e.shiftKey || isShiftPressedRef.current || snapToggledRef.current;
        updateShapePreview([x, y], isSnapped);
        return;
      }

      pointsRef.current.push([x, y]);
      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      const points = pointsRef.current;

      // 1. Draw intermediate stroke locally for 0ms instantaneous visual feedback
      if (points.length >= 2) {
        const seg: [number, number][] = [points[points.length - 2], points[points.length - 1]];
        if (currentTool === "highlighter") {
          drawHighlighter(seg, strokeColor, size);
        } else {
          drawStroke(seg, strokeColor, size);
        }
      }

      // 2. Queue point for 16ms (60 FPS) network batching
      pendingStrokePointsRef.current.push([x, y]);
      if (strokeBatchTimerRef.current === null) {
        strokeBatchTimerRef.current = setTimeout(() => {
          strokeBatchTimerRef.current = null;
          flushPendingStrokePoints();
        }, 16);
      }
    };

    const handlePointerUp = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;

      // Flush any queued points over WebSocket immediately on release
      if (strokeBatchTimerRef.current !== null) {
        clearTimeout(strokeBatchTimerRef.current);
        strokeBatchTimerRef.current = null;
      }
      if (pendingStrokePointsRef.current.length > 0) {
        flushPendingStrokePoints();
      }
      lastDispatchedPointRef.current = null;
      pendingStrokePointsRef.current = [];

      const currentTool = toolRef.current;
      const [rawX, rawY] = getCanvasCoords(e);
      const coords: [number, number] =
        e.clientX === 0 && e.clientY === 0 && lastCoordsRef.current
          ? lastCoordsRef.current
          : [rawX, rawY];

      if (currentTool === "line" || currentTool === "rect" || currentTool === "circle") {
        if (shapeStartRef.current) {
          const start = shapeStartRef.current;
          const isSnapped = e.shiftKey || isShiftPressedRef.current || snapToggledRef.current;
          const end: [number, number] = isSnapped
            ? getConstrainedEnd(start, coords, currentTool as ConstrainableShape)
            : coords;
          const strokeColor = colorRef.current;
          const size = BRUSH_SIZES[brushSizeRef.current];
          const ctx = getCtx();
          if (ctx && shapeSnapshotRef.current) {
            ctx.putImageData(shapeSnapshotRef.current, 0, 0);
          }
          if (currentTool === "line") {
            drawLine(start, end, strokeColor, size);
          } else if (currentTool === "rect") {
            drawRect(start, end, strokeColor, size);
          } else if (currentTool === "circle") {
            drawCircle(start, end, strokeColor, size);
          }

          actionHistoryRef.current.push({
            type: currentTool,
            start,
            end,
            color: strokeColor,
            size,
          });
          redoStackRef.current = [];
          setCanUndo(true);
          setCanRedo(false);
          send("shape", {
            shapeType: currentTool,
            start,
            end,
            color: strokeColor,
            size,
          });
        }
        shapeStartRef.current = null;
        shapeSnapshotRef.current = null;
        lastCoordsRef.current = null;
        return;
      }

      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      const points = pointsRef.current;

      if (currentTool === "highlighter") {
        if (points.length === 1) {
          drawHighlighter(points, strokeColor, size);
        }
        if (points.length > 0) {
          actionHistoryRef.current.push({
            type: "highlighter",
            points: [...points],
            color: strokeColor,
            size,
          });
          redoStackRef.current = [];
          setCanUndo(true);
          setCanRedo(false);
        }
      } else {
        if (points.length === 1) {
          // Single dot — already sent on pointerdown
          drawStroke(points, strokeColor, size);
        }
        if (points.length > 0) {
          actionHistoryRef.current.push({
            type: "stroke",
            points: [...points],
            color: strokeColor,
            size,
          });
          redoStackRef.current = [];
          setCanUndo(true);
          setCanRedo(false);
        }
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
      if (strokeBatchTimerRef.current !== null) {
        clearTimeout(strokeBatchTimerRef.current);
        strokeBatchTimerRef.current = null;
      }
      canvas.removeEventListener("mousedown", handlePointerDown);
      canvas.removeEventListener("mousemove", handlePointerMove);
      canvas.removeEventListener("mouseup", handlePointerUp);
      canvas.removeEventListener("mouseleave", handlePointerUp);
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
    };
  }, [
    canvasRef,
    isDrawer,
    getCanvasCoords,
    getCtx,
    floodFill,
    drawStroke,
    drawHighlighter,
    drawLine,
    drawRect,
    drawCircle,
    updateShapePreview,
    send,
  ]);

  return {
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
    isSnapActive: isShiftPressed || snapToggled,
    snapToggled,
    setSnapToggled,
    renderRemoteStroke,
    renderRemoteHighlighter,
    renderRemoteShape,
    renderRemoteFill,
    renderRemoteUndo,
    getHistory,
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
