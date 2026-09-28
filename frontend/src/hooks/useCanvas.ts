import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./useWebSocket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrawingTool = "pen" | "highlighter" | "eraser" | "fill" | "line" | "rect" | "circle";
export type BrushSize = "xs" | "small" | "medium" | "large" | "xl";

import type { DrawingAction } from "../types";
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

  // Drawing state (mutable refs to avoid re-renders on each event)
  const isDrawingRef = useRef(false);
  const pointsRef = useRef<[number, number][]>([]);

  // Shape dragging preview state
  const shapeStartRef = useRef<[number, number] | null>(null);
  const shapeSnapshotRef = useRef<ImageData | null>(null);

  // Action history for undo/redo
  const actionHistoryRef = useRef<DrawingAction[]>([]);
  const redoStackRef = useRef<DrawingAction[]>([]);

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
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      if (points.length === 1) {
        ctx.lineTo(points[0][0] + 0.1, points[0][1] + 0.1);
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
  // Render remote stroke
  // ---------------------------------------------------------------------------
  const renderRemoteStroke = useCallback(
    (stroke: { points: [number, number][]; color: string; size: number }) => {
      drawStroke(stroke.points, stroke.color, stroke.size);
      actionHistoryRef.current.push({
        type: "stroke",
        points: stroke.points,
        color: stroke.color,
        size: stroke.size,
      });
    },
    [drawStroke]
  );

  // ---------------------------------------------------------------------------
  // Render remote highlighter
  // ---------------------------------------------------------------------------
  const renderRemoteHighlighter = useCallback(
    (highlighter: { points: [number, number][]; color: string; size: number }) => {
      drawHighlighter(highlighter.points, highlighter.color, highlighter.size);
      actionHistoryRef.current.push({
        type: "highlighter",
        points: highlighter.points,
        color: highlighter.color,
        size: highlighter.size,
      });
    },
    [drawHighlighter]
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
    [drawLine, drawRect, drawCircle]
  );

  // ---------------------------------------------------------------------------
  // Render remote fill
  // ---------------------------------------------------------------------------
  const renderRemoteFill = useCallback(
    (fill: { x: number; y: number; color: string }) => {
      floodFill(fill.x, fill.y, fill.color);
      actionHistoryRef.current.push({
        type: "fill",
        x: fill.x,
        y: fill.y,
        color: fill.color,
      });
    },
    [floodFill]
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

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDrawer, undo, redo, clearCanvas, send]);

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
        actionHistoryRef.current.push({ type: "fill", x, y, color: fillColor });
        redoStackRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
        return;
      }

      if (currentTool === "line" || currentTool === "rect" || currentTool === "circle") {
        isDrawingRef.current = true;
        const [x, y] = getCanvasCoords(e);
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
      const [x, y] = getCanvasCoords(e);
      pointsRef.current = [[x, y]];

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

      if (currentTool === "line" || currentTool === "rect" || currentTool === "circle") {
        if (!shapeStartRef.current) return;
        const ctx = getCtx();
        if (!ctx || !canvas) return;
        if (shapeSnapshotRef.current) {
          ctx.putImageData(shapeSnapshotRef.current, 0, 0);
        }
        const strokeColor = colorRef.current;
        const size = BRUSH_SIZES[brushSizeRef.current];
        if (currentTool === "line") {
          drawLine(shapeStartRef.current, [x, y], strokeColor, size);
        } else if (currentTool === "rect") {
          drawRect(shapeStartRef.current, [x, y], strokeColor, size);
        } else if (currentTool === "circle") {
          drawCircle(shapeStartRef.current, [x, y], strokeColor, size);
        }
        return;
      }

      pointsRef.current.push([x, y]);
      const strokeColor = currentTool === "eraser" ? CANVAS_BG : colorRef.current;
      const size = BRUSH_SIZES[brushSizeRef.current];
      const points = pointsRef.current;

      if (currentTool === "highlighter") {
        if (points.length >= 2) {
          const seg: [number, number][] = [points[points.length - 2], points[points.length - 1]];
          drawHighlighter(seg, strokeColor, size);
          send("highlighter", {
            points: seg,
            color: strokeColor,
            size,
          });
        }
      } else {
        // Draw intermediate stroke for immediate visual feedback
        if (points.length >= 2) {
          drawStroke([points[points.length - 2], points[points.length - 1]], strokeColor, size);
          send("stroke", {
            points: [points[points.length - 2], points[points.length - 1]],
            color: strokeColor,
            size,
          });
        }
      }
    };

    const handlePointerUp = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;

      const currentTool = toolRef.current;
      const [x, y] = getCanvasCoords(e);

      if (currentTool === "line" || currentTool === "rect" || currentTool === "circle") {
        if (shapeStartRef.current) {
          const start = shapeStartRef.current;
          const end: [number, number] = [x, y];
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
