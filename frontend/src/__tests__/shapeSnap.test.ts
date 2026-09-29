import { describe, it, expect } from "vitest";
import { getConstrainedEnd } from "../utils/shapeSnap";

describe("shapeSnap utility", () => {
  describe("line constraint (nearest 45°/90°)", () => {
    it("snaps nearly horizontal line to pure horizontal (0°)", () => {
      const start: [number, number] = [100, 100];
      const end: [number, number] = [200, 105]; // ~3 degrees off horizontal
      const snapped = getConstrainedEnd(start, end, "line");
      expect(snapped).toEqual([200, 100]);
    });

    it("snaps nearly vertical line to pure vertical (90°)", () => {
      const start: [number, number] = [100, 100];
      const end: [number, number] = [105, 250]; // ~88 degrees
      const snapped = getConstrainedEnd(start, end, "line");
      expect(snapped).toEqual([100, 250]);
    });

    it("snaps nearly 45° diagonal line to exact 45°", () => {
      const start: [number, number] = [100, 100];
      const end: [number, number] = [180, 190]; // close to 45°
      const snapped = getConstrainedEnd(start, end, "line");
      // maxSide = 90, signs = +1, +1 => [100 + 90, 100 + 90] = [190, 190]
      expect(snapped).toEqual([190, 190]);
    });

    it("snaps nearly 135° diagonal line in negative X quadrant", () => {
      const start: [number, number] = [200, 100];
      const end: [number, number] = [105, 190]; // dx = -95, dy = 90
      const snapped = getConstrainedEnd(start, end, "line");
      // maxSide = 95, signX = -1, signY = 1 => [200 - 95, 100 + 95] = [105, 195]
      expect(snapped).toEqual([105, 195]);
    });

    it("returns same point if start equals end", () => {
      const start: [number, number] = [50, 50];
      expect(getConstrainedEnd(start, [50, 50], "line")).toEqual([50, 50]);
    });
  });

  describe("rect constraint (perfect 1:1 square)", () => {
    it("constrains rectangle to square using max dimension", () => {
      const start: [number, number] = [10, 10];
      const end: [number, number] = [50, 30]; // dx = 40, dy = 20
      const snapped = getConstrainedEnd(start, end, "rect");
      expect(snapped).toEqual([50, 50]); // width = 40, height = 40
    });

    it("handles negative drag direction correctly", () => {
      const start: [number, number] = [100, 100];
      const end: [number, number] = [70, 40]; // dx = -30, dy = -60
      const snapped = getConstrainedEnd(start, end, "rect");
      // maxSide = 60 => [100 - 60, 100 - 60] = [40, 40]
      expect(snapped).toEqual([40, 40]);
    });
  });

  describe("circle constraint (perfect 1:1 circle)", () => {
    it("constrains ellipse to 1:1 circle bounding box", () => {
      const start: [number, number] = [50, 50];
      const end: [number, number] = [120, 90]; // dx = 70, dy = 40
      const snapped = getConstrainedEnd(start, end, "circle");
      expect(snapped).toEqual([120, 120]);
    });
  });
});
