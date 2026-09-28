import { describe, it, expect, vi } from "vitest";
import {
  generateScorecardCanvas,
  generateScorecardBlob,
  downloadScorecard,
  copyScorecardImage,
} from "../utils/shareCard";
import type { PlayerInfo, MvpAward } from "../types";

describe("shareCard utility", () => {
  const samplePlayers: PlayerInfo[] = [
    {
      id: "p1",
      name: "Alice",
      score: 450,
      isHost: true,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
    },
    {
      id: "p2",
      name: "Bob",
      score: 620,
      isHost: false,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
    },
    {
      id: "p3",
      name: "Charlie",
      score: 280,
      isHost: false,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
    },
    {
      id: "p4",
      name: "David",
      score: 110,
      isHost: false,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
    },
  ];

  const sampleMvps: MvpAward[] = [
    {
      badge: "⚡ Speed Demon",
      title: "Fastest Guesser",
      playerId: "p2",
      playerName: "Bob",
      detail: "2.8s",
    },
    {
      badge: "🎨 Master Artist",
      title: "Top Drawer",
      playerId: "p1",
      playerName: "Alice",
      detail: "140 pts",
    },
  ];

  it("generates a 1200x630 canvas element", () => {
    const canvas = generateScorecardCanvas({
      roomCode: "XYZ123",
      players: samplePlayers,
      mvpAwards: sampleMvps,
    });
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(630);
  });

  it("generates a blob from the canvas", async () => {
    // Mock toBlob on HTMLCanvasElement in JSDOM
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      callback: (blob: Blob | null) => void
    ) {
      callback(new Blob(["mock-image-data"], { type: "image/png" }));
    });

    const blob = await generateScorecardBlob({
      roomCode: "XYZ123",
      players: samplePlayers,
    });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/png");
  });

  it("triggers download by creating and clicking a link", async () => {
    const appendSpy = vi.spyOn(document.body, "appendChild");
    const removeSpy = vi.spyOn(document.body, "removeChild");

    await downloadScorecard({ roomCode: "XYZ123", players: samplePlayers });

    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
  });

  it("copies image to clipboard if ClipboardItem and write are available", async () => {
    const mockWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        write: mockWrite,
      },
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = vi.fn();

    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      callback: (blob: Blob | null) => void
    ) {
      callback(new Blob(["mock-png"], { type: "image/png" }));
    });

    const ok = await copyScorecardImage({ roomCode: "XYZ123", players: samplePlayers });
    expect(ok).toBe(true);
    expect(mockWrite).toHaveBeenCalled();
  });
});
