import { describe, it, expect } from "vitest";
import {
  encodeStroke,
  encodeFill,
  encodeClearCanvas,
  decodeBinaryDrawEvents,
  DRAW_OPCODE,
  hexToRgb,
  rgbToHex,
} from "../utils/binaryDrawing";

describe("binaryDrawing codec", () => {
  it("converts hex to RGB and back accurately", () => {
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#ff007f")).toEqual([255, 0, 127]);
    expect(hexToRgb("#f07")).toEqual([255, 0, 119]);

    expect(rgbToHex(255, 0, 127)).toBe("#ff007f");
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
  });

  it("encodes and decodes a single-point stroke", () => {
    const points: [number, number][] = [[120, 240]];
    const encoded = encodeStroke(points, "#2979ff", 4);

    expect(encoded[0]).toBe(DRAW_OPCODE.STROKE);
    expect(encoded.byteLength).toBe(11); // 7 header + 4 point

    const decoded = decodeBinaryDrawEvents(encoded.buffer);
    expect(decoded.length).toBe(1);
    expect(decoded[0].type).toBe("stroke");

    const payload = decoded[0].payload as {
      points: [number, number][];
      color: string;
      size: number;
    };
    expect(payload.points).toEqual([[120, 240]]);
    expect(payload.color.toLowerCase()).toBe("#2979ff");
    expect(payload.size).toBe(4);
  });

  it("encodes and decodes a multi-point highlighter stroke", () => {
    const points: [number, number][] = [
      [10, 20],
      [30, 40],
      [50, 60],
      [70, 80],
    ];
    const encoded = encodeStroke(points, "#ffd700", 8, true);

    expect(encoded[0]).toBe(DRAW_OPCODE.HIGHLIGHTER);
    expect(encoded.byteLength).toBe(23); // 7 header + 16 points (4*4)

    const decoded = decodeBinaryDrawEvents(encoded.buffer);
    expect(decoded.length).toBe(1);
    expect(decoded[0].type).toBe("highlighter");

    const payload = decoded[0].payload as {
      points: [number, number][];
      color: string;
      size: number;
    };
    expect(payload.points).toEqual(points);
    expect(payload.color.toLowerCase()).toBe("#ffd700");
    expect(payload.size).toBe(8);
  });

  it("encodes and decodes fill event", () => {
    const encoded = encodeFill(350, 450, "#00c853");
    expect(encoded[0]).toBe(DRAW_OPCODE.FILL);
    expect(encoded.byteLength).toBe(8);

    const decoded = decodeBinaryDrawEvents(encoded.buffer);
    expect(decoded.length).toBe(1);
    expect(decoded[0].type).toBe("fill");

    const payload = decoded[0].payload as { x: number; y: number; color: string };
    expect(payload.x).toBe(350);
    expect(payload.y).toBe(450);
    expect(payload.color.toLowerCase()).toBe("#00c853");
  });

  it("encodes and decodes clear_canvas event", () => {
    const encoded = encodeClearCanvas();
    expect(encoded[0]).toBe(DRAW_OPCODE.CLEAR_CANVAS);
    expect(encoded.byteLength).toBe(1);

    const decoded = decodeBinaryDrawEvents(encoded.buffer);
    expect(decoded.length).toBe(1);
    expect(decoded[0].type).toBe("clear_canvas");
  });

  it("decodes coalesced burst frames containing multiple records in sequence", () => {
    const stroke1 = encodeStroke([[100, 100]], "#000000", 3);
    const stroke2 = encodeStroke([[105, 102]], "#000000", 3);
    const fill = encodeFill(50, 50, "#e50000");

    // Concatenate into a single buffer as writePump would do during a burst
    const coalesced = new Uint8Array(stroke1.byteLength + stroke2.byteLength + fill.byteLength);
    coalesced.set(stroke1, 0);
    coalesced.set(stroke2, stroke1.byteLength);
    coalesced.set(fill, stroke1.byteLength + stroke2.byteLength);

    const decoded = decodeBinaryDrawEvents(coalesced.buffer);
    expect(decoded.length).toBe(3);
    expect(decoded[0].type).toBe("stroke");
    expect(decoded[1].type).toBe("stroke");
    expect(decoded[2].type).toBe("fill");
  });
});
