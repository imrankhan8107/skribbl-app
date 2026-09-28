import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyToClipboard } from "../utils/clipboard";

describe("copyToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
    document.execCommand = originalExecCommand;
  });

  it("returns false if text is empty", async () => {
    const result = await copyToClipboard("");
    expect(result).toBe(false);
  });

  it("uses navigator.clipboard.writeText when available and resolves", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    const result = await copyToClipboard("ROOM123");
    expect(result).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("ROOM123");
  });

  it("falls back to execCommand('copy') when navigator.clipboard is missing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    const result = await copyToClipboard("ROOM456");
    expect(result).toBe(true);
    expect(execMock).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand('copy') when navigator.clipboard.writeText throws", async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    const result = await copyToClipboard("ROOM789");
    expect(result).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("ROOM789");
    expect(execMock).toHaveBeenCalledWith("copy");
  });
});
