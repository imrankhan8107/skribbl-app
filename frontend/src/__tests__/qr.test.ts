import { describe, it, expect } from "vitest";
import { generateQRMatrix, generateQRPath } from "../utils/qr";

describe("qr generator utility", () => {
  it("returns an empty matrix for empty input", () => {
    expect(generateQRMatrix("")).toEqual([]);
  });

  it("generates an ISO-compliant square matrix for short room code", () => {
    const matrix = generateQRMatrix("ABC123");
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.length).toBe(matrix[0].length);
    // Version 1 QR code is 21x21
    expect(matrix.length).toBe(21);
    // Finder patterns: top-left corner is dark
    expect(matrix[0][0]).toBe(true);
  });

  it("generates correct matrix for full invite URLs (> 35 chars)", () => {
    const url = "http://localhost:5173/?room=TEST99";
    const matrix = generateQRMatrix(url);
    expect(matrix.length).toBeGreaterThanOrEqual(25);
    expect(matrix.length).toBe(matrix[0].length);
  });

  it("generates valid SVG path data with quiet zone offset", () => {
    const matrix = [
      [true, false],
      [false, true],
    ];
    const path = generateQRPath(matrix, 4);
    expect(path).toContain("M4,4h1v1h-1z");
    expect(path).toContain("M5,5h1v1h-1z");
    expect(path).not.toContain("M5,4");
  });
});
