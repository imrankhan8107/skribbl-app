/**
 * Shape snapping utility functions.
 * Constrains shape coordinates when holding Shift:
 * - Line: Snaps to nearest 0°, 45°, 90°, 135°, 180°, etc.
 * - Rect: Snaps to perfect 1:1 square.
 * - Circle: Snaps to perfect 1:1 circle.
 */

export type ConstrainableShape = "line" | "rect" | "circle";

export function getConstrainedEnd(
  start: [number, number],
  end: [number, number],
  shapeType: ConstrainableShape
): [number, number] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];

  if (dx === 0 && dy === 0) {
    return [end[0], end[1]];
  }

  if (shapeType === "line") {
    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4; // 45 degrees
    const snappedK = Math.round(angle / step);

    // K modulo 8:
    // 0 or 4 or -4: Horizontal line (0° or 180°)
    if (snappedK === 0 || Math.abs(snappedK) === 4) {
      return [end[0], start[1]];
    }

    // 2 or -2: Vertical line (90° or 270°)
    if (Math.abs(snappedK) === 2) {
      return [start[0], end[1]];
    }

    // 1, -1, 3, -3: 45° diagonal line
    const maxSide = Math.max(Math.abs(dx), Math.abs(dy));
    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;
    return [start[0] + maxSide * signX, start[1] + maxSide * signY];
  }

  if (shapeType === "rect" || shapeType === "circle") {
    // 1:1 aspect ratio constraint
    const maxSide = Math.max(Math.abs(dx), Math.abs(dy));
    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;
    return [start[0] + maxSide * signX, start[1] + maxSide * signY];
  }

  return [end[0], end[1]];
}
