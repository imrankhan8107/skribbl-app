/**
 * Web Audio API Sound Effects Engine for Skribbl
 * Zero external audio assets, works completely client-side.
 */

class SoundEffectsManager {
  private ctx: AudioContext | null = null;
  private muted: boolean = false;
  private lastTickSecond: number | null = null;

  constructor() {
    try {
      if (typeof window !== "undefined" && typeof window.localStorage?.getItem === "function") {
        const saved = window.localStorage.getItem("skribbl_sound_muted");
        this.muted = saved === "true";
      }
    } catch {
      this.muted = false;
    }
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
        window.localStorage.setItem("skribbl_sound_muted", String(this.muted));
      }
    } catch {
      // Ignore storage errors
    }
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
        window.localStorage.setItem("skribbl_sound_muted", String(this.muted));
      }
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Helper to play an oscillator tone with envelope gain
   */
  private playTone(
    freq: number,
    type: OscillatorType,
    duration: number,
    delay = 0,
    peakGain = 0.15
  ): void {
    if (this.muted) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + duration + 0.05);
    } catch {
      // Audio context might be restricted before user gesture
    }
  }

  /**
   * Correct guess: Ascending C-E-G-C chime (Major triad)
   */
  public playCorrectGuess(): void {
    if (this.muted) return;
    this.playTone(523.25, "triangle", 0.15, 0.0, 0.2); // C5
    this.playTone(659.25, "triangle", 0.15, 0.1, 0.2); // E5
    this.playTone(783.99, "triangle", 0.18, 0.2, 0.22); // G5
    this.playTone(1046.5, "sine", 0.35, 0.3, 0.25); // C6
  }

  /**
   * Close guess: Gentle double tone (E4 -> G4)
   */
  public playCloseGuess(): void {
    if (this.muted) return;
    this.playTone(329.63, "sine", 0.12, 0.0, 0.18); // E4
    this.playTone(392.0, "sine", 0.18, 0.1, 0.18); // G4
  }

  /**
   * Timer countdown warning tick (when remaining time <= 10s)
   */
  public playTimerTick(remainingSeconds: number): void {
    if (this.muted || remainingSeconds > 10 || remainingSeconds <= 0) return;
    if (this.lastTickSecond === remainingSeconds) return;
    this.lastTickSecond = remainingSeconds;

    // Pitch rises slightly on the final 3 seconds for urgency
    const freq = remainingSeconds <= 3 ? 987.77 : 880.0; // B5 or A5
    this.playTone(freq, "sine", 0.05, 0, 0.12);
  }

  /**
   * Round start: Upbeat notification chord
   */
  public playRoundStart(): void {
    if (this.muted) return;
    this.playTone(440.0, "triangle", 0.15, 0.0, 0.18); // A4
    this.playTone(554.37, "triangle", 0.15, 0.08, 0.18); // C#5
    this.playTone(659.25, "triangle", 0.25, 0.16, 0.2); // E5
  }

  /**
   * Game over fanfare
   */
  public playGameOver(): void {
    if (this.muted) return;
    this.playTone(523.25, "square", 0.2, 0.0, 0.1);
    this.playTone(659.25, "square", 0.2, 0.18, 0.1);
    this.playTone(783.99, "square", 0.2, 0.36, 0.1);
    this.playTone(1046.5, "triangle", 0.6, 0.54, 0.15);
  }
}

export const soundManager = new SoundEffectsManager();
