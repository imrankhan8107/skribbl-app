import QRCode from "qrcode";

/**
 * Generate a 2D boolean grid representing an ISO/IEC 18004 compliant QR Code for the given text.
 * Uses optimal mask pattern selection, Reed-Solomon block interleaving, and Level M ECC.
 * Returns `boolean[][]` where `true` = dark module, `false` = light module.
 */
export function generateQRMatrix(text: string): boolean[][] {
  if (!text) {
    return [];
  }
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const matrix: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) {
      row.push(Boolean(qr.modules.get(r, c)));
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Generate an SVG path data string for all dark modules with a given quiet zone.
 * Merges modules into a single vector path for crisp rendering without subpixel gaps.
 */
export function generateQRPath(matrix: boolean[][], quietZone: number = 4): string {
  let path = "";
  const size = matrix.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        path += `M${c + quietZone},${r + quietZone}h1v1h-1z `;
      }
    }
  }
  return path;
}
