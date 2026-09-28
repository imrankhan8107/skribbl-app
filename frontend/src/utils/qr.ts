/**
 * Lightweight, zero-dependency QR Code Matrix Generator.
 * Implements ISO/IEC 18004 QR Code standard for Byte mode (Version 1 to 4, ECC Level M).
 * Generates a 2D boolean array where true = dark module, false = light module.
 */

// GF(256) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = val;
    GF_EXP[i + 255] = val;
    GF_LOG[val] = i;
    val = (val << 1) ^ (val & 0x80 ? 0x11d : 0);
  }
})();

function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return GF_EXP[GF_LOG[x] + GF_LOG[y]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const factor = new Uint8Array([1, GF_EXP[i]]);
    const newPoly = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      for (let k = 0; k < factor.length; k++) {
        newPoly[j + k] ^= gfMul(poly[j], factor[k]);
      }
    }
    poly = newPoly;
  }
  return poly;
}

function calculateEcc(data: Uint8Array, eccCount: number): Uint8Array {
  const gen = rsGeneratorPoly(eccCount);
  const result = new Uint8Array(eccCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[eccCount - 1] = 0;
    for (let j = 0; j < eccCount; j++) {
      result[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return result;
}

// Table of QR Code versions (ECC Level M)
// version: size, totalCodewords, dataCodewords, eccCodewords, alignmentPositions
interface QRVersionSpec {
  version: number;
  size: number;
  totalCodewords: number;
  dataCodewords: number;
  eccCodewords: number;
  alignments: number[];
}

const VERSIONS: QRVersionSpec[] = [
  { version: 1, size: 21, totalCodewords: 26, dataCodewords: 16, eccCodewords: 10, alignments: [] },
  {
    version: 2,
    size: 25,
    totalCodewords: 44,
    dataCodewords: 28,
    eccCodewords: 16,
    alignments: [6, 18],
  },
  {
    version: 3,
    size: 29,
    totalCodewords: 70,
    dataCodewords: 44,
    eccCodewords: 26,
    alignments: [6, 22],
  },
  {
    version: 4,
    size: 33,
    totalCodewords: 100,
    dataCodewords: 64,
    eccCodewords: 36,
    alignments: [6, 26],
  },
  {
    version: 5,
    size: 37,
    totalCodewords: 134,
    dataCodewords: 86,
    eccCodewords: 48,
    alignments: [6, 30],
  },
];

// Format info bits for ECC Level M (00) with Mask patterns
// Formats: Level M = 00. Format string with mask 0..7 (BCH 15,5 with XOR 0x5412)
const FORMAT_INFO_M = [
  0x5412, // Mask 0: (row + col) % 2 == 0
  0x5125, // Mask 1: row % 2 == 0
  0x5e7c, // Mask 2: col % 3 == 0
  0x5b4b, // Mask 3: (row + col) % 3 == 0
  0x45f9, // Mask 4: (floor(row/2) + floor(col/3)) % 2 == 0
  0x40ce, // Mask 5: (row*col)%2 + (row*col)%3 == 0
  0x4f97, // Mask 6: ((row*col)%2 + (row*col)%3) % 2 == 0
  0x4aa0, // Mask 7: ((row+col)%2 + (row*col)%3) % 2 == 0
];

/**
 * Generate a 2D boolean grid representing the QR Code for the given text.
 * returns `boolean[][]` where `true` = dark module, `false` = light module.
 */
export function generateQRMatrix(text: string): boolean[][] {
  const textBytes = new TextEncoder().encode(text);
  const dataLen = textBytes.length;

  // Find minimum version that fits (Byte mode: 4-bit mode + 8-bit length + data)
  const requiredBits = 4 + 8 + dataLen * 8;
  const spec = VERSIONS.find((v) => v.dataCodewords * 8 >= requiredBits);
  if (!spec) {
    throw new Error(`Text too long for supported QR versions (max ~84 bytes): ${dataLen}`);
  }

  // 1. Bit buffer
  const bitBuffer: number[] = [];
  function pushBits(val: number, length: number) {
    for (let i = length - 1; i >= 0; i--) {
      bitBuffer.push((val >>> i) & 1);
    }
  }

  // Mode: Byte mode (0100)
  pushBits(0b0100, 4);
  // Character count
  pushBits(dataLen, 8);
  // Text bytes
  for (let i = 0; i < textBytes.length; i++) {
    pushBits(textBytes[i], 8);
  }

  // Terminator (up to 4 zeroes)
  const maxDataBits = spec.dataCodewords * 8;
  const termLen = Math.min(4, maxDataBits - bitBuffer.length);
  pushBits(0, termLen);

  // Pad to byte boundary
  while (bitBuffer.length % 8 !== 0) {
    bitBuffer.push(0);
  }

  // Pad with alternating 0xEC, 0x11
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bitBuffer.length < maxDataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bit buffer to data codewords
  const dataCodewords = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < spec.dataCodewords; i++) {
    let byteVal = 0;
    for (let b = 0; b < 8; b++) {
      byteVal = (byteVal << 1) | bitBuffer[i * 8 + b];
    }
    dataCodewords[i] = byteVal;
  }

  // 2. ECC codewords
  const eccCodewords = calculateEcc(dataCodewords, spec.eccCodewords);

  // Combine data + ecc
  const allCodewords = new Uint8Array(spec.totalCodewords);
  allCodewords.set(dataCodewords, 0);
  allCodewords.set(eccCodewords, spec.dataCodewords);

  // 3. Setup grid & function pattern reserved map
  const size = spec.size;
  const grid: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  function setFunctionModule(r: number, c: number, val: boolean) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      grid[r][c] = val;
      isFunction[r][c] = true;
    }
  }

  // Finder patterns at top-left, top-right, bottom-left
  function addFinderPattern(startR: number, startC: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = startR + r;
        const nc = startC + c;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
          const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
          const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
          const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          setFunctionModule(nr, nc, !isBorder && (isOuter || isInner));
        }
      }
    }
  }

  addFinderPattern(0, 0);
  addFinderPattern(0, size - 7);
  addFinderPattern(size - 7, 0);

  // Alignment patterns
  if (spec.alignments.length > 0) {
    for (const ar of spec.alignments) {
      for (const ac of spec.alignments) {
        // Skip if overlaps finder patterns
        if ((ar < 8 && ac < 8) || (ar < 8 && ac >= size - 8) || (ar >= size - 8 && ac < 8)) {
          continue;
        }
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const isCenter = r === 0 && c === 0;
            const isBorder = Math.abs(r) === 2 || Math.abs(c) === 2;
            setFunctionModule(ar + r, ac + c, isBorder || isCenter);
          }
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Dark module
  setFunctionModule(size - 8, 8, true);

  // Reserve format info area
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }

  // Mask pattern 0: (row + col) % 2 === 0
  const maskFn = (r: number, c: number) => (r + c) % 2 === 0;

  // 4. Place data bits in 2-column zigzag from right to left
  let bitIdx = 0;
  const totalBits = spec.totalCodewords * 8;
  const allBits: number[] = [];
  for (let i = 0; i < spec.totalCodewords; i++) {
    for (let b = 7; b >= 0; b--) {
      allBits.push((allCodewords[i] >>> b) & 1);
    }
  }

  for (let rightCol = size - 1; rightCol > 0; rightCol -= 2) {
    if (rightCol === 6) rightCol--; // Skip vertical timing pattern column
    const goingUp = ((size - 1 - rightCol) / 2) % 2 === 0;
    for (let v = 0; v < size; v++) {
      const row = goingUp ? size - 1 - v : v;
      for (let colOffset = 0; colOffset < 2; colOffset++) {
        const col = rightCol - colOffset;
        if (!isFunction[row][col]) {
          let bit = bitIdx < totalBits ? allBits[bitIdx] : 0;
          bitIdx++;
          // Apply mask
          if (maskFn(row, col)) {
            bit ^= 1;
          }
          grid[row][col] = bit === 1;
        }
      }
    }
  }

  // 5. Write Format Information (Level M, Mask 0)
  const formatBits = FORMAT_INFO_M[0];
  for (let i = 0; i < 15; i++) {
    const bit = ((formatBits >>> i) & 1) === 1;
    // Around top-left finder pattern
    if (i <= 5) {
      grid[8][i] = bit;
    } else if (i === 6) {
      grid[8][7] = bit;
    } else if (i === 7) {
      grid[8][8] = bit;
    } else if (i === 8) {
      grid[7][8] = bit;
    } else {
      grid[14 - i][8] = bit;
    }

    // Second copy (split between bottom-left and top-right)
    if (i < 8) {
      grid[size - 1 - i][8] = bit;
    } else {
      grid[8][size - 15 + i] = bit;
    }
  }

  return grid;
}
