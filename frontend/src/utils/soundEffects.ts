/**
 * Web Audio API Sound Effects Engine for Skribbl
 * Zero external audio assets, works completely client-side.
 * Includes tone synthesis and browser Web Speech API voice synthesis.
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

    // Automatically unlock AudioContext on first user interaction anywhere on the page
    if (typeof window !== "undefined") {
      const unlockAudio = () => {
        const ctx = this.getAudioContext();
        if (ctx && ctx.state === "suspended") {
          ctx.resume().catch(() => {});
        }
      };
      window.addEventListener("click", unlockAudio, { passive: true });
      window.addEventListener("keydown", unlockAudio, { passive: true });
      window.addEventListener("touchstart", unlockAudio, { passive: true });
      window.addEventListener("pointerdown", unlockAudio, { passive: true });
    }
  }

  public getAudioContext(): AudioContext | null {
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
    peakGain = 0.35
  ): void {
    if (this.muted) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    try {
      const startTime = ctx.currentTime + Math.max(delay, 0) + 0.01;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);

      // Crisp attack and natural linear decay
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
      gain.gain.linearRampToValueAtTime(0.001, startTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
    } catch {
      // Audio context might be restricted before user gesture
    }
  }

  /**
   * Voice Announcement using Web Speech API (if supported)
   */
  public speak(text: string): void {
    if (this.muted || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.1;
      utterance.volume = 0.8;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Speech synthesis unsupported or blocked
    }
  }

  /**
   * Correct guess: Ascending C-E-G-C chime (Major triad)
   */
  public playCorrectGuess(playerName?: string): void {
    if (this.muted) return;
    this.playTone(523.25, "triangle", 0.15, 0.0, 0.35); // C5
    this.playTone(659.25, "triangle", 0.15, 0.1, 0.35); // E5
    this.playTone(783.99, "triangle", 0.18, 0.2, 0.4); // G5
    this.playTone(1046.5, "sine", 0.4, 0.3, 0.45); // C6

    if (playerName) {
      setTimeout(() => {
        this.speak(`${playerName} guessed the word!`);
      }, 350);
    }
  }

  /**
   * Close guess: Gentle double tone (E4 -> G4)
   */
  public playCloseGuess(): void {
    if (this.muted) return;
    this.playTone(329.63, "sine", 0.14, 0.0, 0.3); // E4
    this.playTone(392.0, "sine", 0.2, 0.12, 0.3); // G4
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
    this.playTone(freq, "sine", 0.08, 0, 0.25);
  }

  /**
   * Round start: Upbeat notification chord + announcement
   */
  public playRoundStart(roundNumber?: number): void {
    if (this.muted) return;
    this.playTone(440.0, "triangle", 0.15, 0.0, 0.35); // A4
    this.playTone(554.37, "triangle", 0.15, 0.08, 0.35); // C#5
    this.playTone(659.25, "triangle", 0.3, 0.16, 0.4); // E5

    if (roundNumber) {
      setTimeout(() => {
        this.speak(`Round ${roundNumber}! Start drawing!`);
      }, 300);
    }
  }

  /**
   * Game over fanfare
   */
  public playGameOver(): void {
    if (this.muted) return;
    this.playTone(523.25, "square", 0.2, 0.0, 0.2);
    this.playTone(659.25, "square", 0.2, 0.18, 0.2);
    this.playTone(783.99, "square", 0.2, 0.36, 0.2);
    this.playTone(1046.5, "triangle", 0.6, 0.54, 0.3);
    setTimeout(() => {
      this.speak("Game over! Great game!");
    }, 600);
  }
}

export const soundManager = new SoundEffectsManager();
