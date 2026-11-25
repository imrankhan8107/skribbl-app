// ---------------------------------------------------------------------------
// Shareable Word Pack Codec — encodes/decodes custom word packs into compact
// URL-safe strings (`?pack=...`) with sessionStorage handoff from Landing -> Lobby.
// ---------------------------------------------------------------------------

const SHARED_PACK_STORAGE_KEY = "skribbl_shared_pack";
const MAX_PACK_WORDS = 100;
const MAX_WORD_LENGTH = 40;

/** Parse a comma/newline separated string into deduplicated, trimmed words. */
export function parseWordList(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of raw.split(/[\n,]+/)) {
    const cleaned = part.trim().slice(0, MAX_WORD_LENGTH);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_PACK_WORDS) break;
  }

  return result;
}

/** Encode a list of words into a URL-safe base64url string. */
export function encodeWordPack(words: string[]): string {
  const normalized = parseWordList(words.join(","));
  if (normalized.length === 0) return "";

  const payload = normalized.join("\n");
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Decode a URL-safe base64url pack string back into a clean list of words. */
export function decodeWordPack(encoded: string): string[] {
  if (!encoded || typeof encoded !== "string") return [];
  try {
    let base64 = encoded.trim().replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) {
      base64 += "=";
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decoded = new TextDecoder().decode(bytes);
    return parseWordList(decoded);
  } catch {
    return [];
  }
}

/** Build a full shareable URL for the given word list. */
export function buildShareablePackUrl(words: string[], origin = window.location.origin): string {
  const encoded = encodeWordPack(words);
  if (!encoded) return origin;
  return `${origin}/?pack=${encoded}`;
}

export function savePendingSharedPack(words: string[]): void {
  if (words.length === 0) return;
  try {
    sessionStorage.setItem(SHARED_PACK_STORAGE_KEY, JSON.stringify(words));
  } catch {
    /* ignore storage errors */
  }
}

export function loadPendingSharedPack(): string[] {
  try {
    const raw = sessionStorage.getItem(SHARED_PACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function clearPendingSharedPack(): void {
  try {
    sessionStorage.removeItem(SHARED_PACK_STORAGE_KEY);
  } catch {
    /* ignore storage errors */
  }
}
