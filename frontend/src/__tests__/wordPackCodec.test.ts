import { describe, it, expect, beforeEach } from "vitest";
import {
  buildShareablePackUrl,
  clearPendingSharedPack,
  decodeWordPack,
  encodeWordPack,
  loadPendingSharedPack,
  parseWordList,
  savePendingSharedPack,
} from "../utils/wordPackCodec";

describe("wordPackCodec", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("parses, trims, and deduplicates comma and newline separated words", () => {
    const words = parseWordList("Naruto, pikachu\nNARUTO,  Goku , , ");
    expect(words).toEqual(["Naruto", "pikachu", "Goku"]);
  });

  it("encodes and decodes ASCII and Unicode word packs losslessly", () => {
    const original = ["Naruto", "Pokémon", "Spider-Man", "Café", "Mount Fuji"];
    const encoded = encodeWordPack(original);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(decodeWordPack(encoded)).toEqual(original);
  });

  it("returns an empty array for invalid or empty encoded strings", () => {
    expect(decodeWordPack("")).toEqual([]);
    expect(decodeWordPack("!!!not-base64!!!")).toEqual([]);
  });

  it("builds a shareable pack URL with ?pack= query param", () => {
    const url = buildShareablePackUrl(["Japan", "Brazil"], "https://skribbl-app.duckdns.org");
    expect(url.startsWith("https://skribbl-app.duckdns.org/?pack=")).toBe(true);
    const param = url.split("?pack=")[1];
    expect(decodeWordPack(param)).toEqual(["Japan", "Brazil"]);
  });

  it("stores, loads, and clears pending shared packs in sessionStorage", () => {
    savePendingSharedPack(["Server", "Firewall"]);
    expect(loadPendingSharedPack()).toEqual(["Server", "Firewall"]);
    clearPendingSharedPack();
    expect(loadPendingSharedPack()).toEqual([]);
  });
});
