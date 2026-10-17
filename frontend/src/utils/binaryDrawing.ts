import type { DrawingEvent } from "../context/drawingBus";

// ---------------------------------------------------------------------------
// Binary Drawing Protocol (Phase 1 Optimization)
//
// Wire format opcodes:
//   0x01: STROKE        [1B Opcode][3B RGB][1B Size][2B Count N][N x 4B (uint16 X, uint16 Y)]
//   0x02: CLEAR_CANVAS  [1B Opcode]
//   0x03: FILL          [1B Opcode][3B RGB][2B uint16 X][2B uint16 Y]
//   0x04: HIGHLIGHTER   [1B Opcode][3B RGB][1B Size][2B Count N][N x 4B (uint16 X, uint16 Y)]
// ---------------------------------------------------------------------------

export const DRAW_OPCODE = {
  STROKE: 0x01,
  CLEAR_CANVAS: 0x02,
  FILL: 0x03,
  HIGHLIGHTER: 0x04,
} as const;

/** Convert "#RRGGBB" or "#RGB" hex color string to [R, G, B] numeric tuple (0-255). */
export function hexToRgb(hex: string): [number, number, number] {
  let clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length === 3) {
    clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  const val = parseInt(clean, 16);
  if (isNaN(val)) return [0, 0, 0];
  return [(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff];
}

/** Convert [R, G, B] numbers to "#rrggbb" hex string. */
export function rgbToHex(r: number, g: number, b: number): string {
  const rs = Math.max(0, Math.min(255, r)).toString(16).padStart(2, "0");
  const gs = Math.max(0, Math.min(255, g)).toString(16).padStart(2, "0");
  const bs = Math.max(0, Math.min(255, b)).toString(16).padStart(2, "0");
  return `#${rs}${gs}${bs}`;
}

/** Encode a stroke or highlighter segment into a compact binary buffer. */
export function encodeStroke(
  points: [number, number][],
  colorHex: string,
  size: number,
  isHighlighter = false
): Uint8Array {
  const opcode = isHighlighter ? DRAW_OPCODE.HIGHLIGHTER : DRAW_OPCODE.STROKE;
  const [r, g, b] = hexToRgb(colorHex);
  const brushSize = Math.max(1, Math.min(255, Math.round(size)));
  const count = points.length;

  const totalBytes = 7 + count * 4;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);

  view.setUint8(0, opcode);
  view.setUint8(1, r);
  view.setUint8(2, g);
  view.setUint8(3, b);
  view.setUint8(4, brushSize);
  view.setUint16(5, count, false); // Big-Endian

  let offset = 7;
  for (let i = 0; i < count; i++) {
    const pt = points[i];
    const x = Math.max(0, Math.min(65535, Math.round(pt[0])));
    const y = Math.max(0, Math.min(65535, Math.round(pt[1])));
    view.setUint16(offset, x, false);
    view.setUint16(offset + 2, y, false);
    offset += 4;
  }

  return new Uint8Array(buf);
}

/** Encode a fill event into an 8-byte binary buffer. */
export function encodeFill(x: number, y: number, colorHex: string): Uint8Array {
  const [r, g, b] = hexToRgb(colorHex);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);

  view.setUint8(0, DRAW_OPCODE.FILL);
  view.setUint8(1, r);
  view.setUint8(2, g);
  view.setUint8(3, b);
  view.setUint16(4, Math.max(0, Math.min(65535, Math.round(x))), false);
  view.setUint16(6, Math.max(0, Math.min(65535, Math.round(y))), false);

  return new Uint8Array(buf);
}

/** Encode clear canvas into a single-byte binary buffer. */
export function encodeClearCanvas(): Uint8Array {
  return new Uint8Array([DRAW_OPCODE.CLEAR_CANVAS]);
}

/**
 * Decode one or more contiguous binary draw event records from an ArrayBuffer.
 * Handles burst-coalesced frames where multiple records were sent in one WebSocket frame.
 */
export function decodeBinaryDrawEvents(buffer: ArrayBuffer): DrawingEvent[] {
  const events: DrawingEvent[] = [];
  const view = new DataView(buffer);
  let offset = 0;
  const len = view.byteLength;

  while (offset < len) {
    const opcode = view.getUint8(offset);
    offset += 1;

    switch (opcode) {
      case DRAW_OPCODE.STROKE:
      case DRAW_OPCODE.HIGHLIGHTER: {
        if (offset + 6 > len) return events; // truncated header
        const r = view.getUint8(offset);
        const g = view.getUint8(offset + 1);
        const b = view.getUint8(offset + 2);
        const size = view.getUint8(offset + 3);
        const count = view.getUint16(offset + 4, false);
        offset += 6;

        if (offset + count * 4 > len) return events; // truncated points

        const points: [number, number][] = new Array(count);
        for (let i = 0; i < count; i++) {
          const x = view.getUint16(offset, false);
          const y = view.getUint16(offset + 2, false);
          points[i] = [x, y];
          offset += 4;
        }

        const color = rgbToHex(r, g, b);
        const type = opcode === DRAW_OPCODE.HIGHLIGHTER ? "highlighter" : "stroke";
        events.push({
          type,
          payload: { points, color, size },
        });
        break;
      }

      case DRAW_OPCODE.CLEAR_CANVAS: {
        events.push({
          type: "clear_canvas",
          payload: {},
        });
        break;
      }

      case DRAW_OPCODE.FILL: {
        if (offset + 7 > len) return events; // truncated fill payload
        const r = view.getUint8(offset);
        const g = view.getUint8(offset + 1);
        const b = view.getUint8(offset + 2);
        const x = view.getUint16(offset + 3, false);
        const y = view.getUint16(offset + 5, false);
        offset += 7;

        events.push({
          type: "fill",
          payload: { x, y, color: rgbToHex(r, g, b) },
        });
        break;
      }

      default:
        // Unknown opcode, abort reading remaining stream
        return events;
    }
  }

  return events;
}
