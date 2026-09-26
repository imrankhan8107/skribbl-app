import { describe, it, expect, beforeEach, vi } from "vitest";
import { soundManager } from "../utils/soundEffects";

describe("SoundEffectsManager", () => {
  beforeEach(() => {
    localStorage.clear();
    soundManager.setMuted(false);
  });

  it("initializes with unmuted state by default", () => {
    expect(soundManager.isMuted()).toBe(false);
  });

  it("toggles mute state and persists to localStorage", () => {
    const isMutedNow = soundManager.toggleMute();
    expect(isMutedNow).toBe(true);
    expect(soundManager.isMuted()).toBe(true);
    expect(localStorage.getItem("skribbl_sound_muted")).toBe("true");

    const isUnmutedNow = soundManager.toggleMute();
    expect(isUnmutedNow).toBe(false);
    expect(soundManager.isMuted()).toBe(false);
    expect(localStorage.getItem("skribbl_sound_muted")).toBe("false");
  });

  it("safely invokes audio methods without throwing errors in headless environment", () => {
    expect(() => {
      soundManager.playCorrectGuess();
      soundManager.playCloseGuess();
      soundManager.playRoundStart();
      soundManager.playGameOver();
      soundManager.playTimerTick(5);
      soundManager.playTimerTick(2);
    }).not.toThrow();
  });

  it("does not play timer tick if remaining seconds > 10", () => {
    const spy = vi.spyOn(soundManager as any, "playTone");
    soundManager.playTimerTick(15);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not play sounds when muted", () => {
    soundManager.setMuted(true);
    const spy = vi.spyOn(soundManager as any, "playTone");
    soundManager.playCorrectGuess();
    soundManager.playCloseGuess();
    soundManager.playTimerTick(5);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
