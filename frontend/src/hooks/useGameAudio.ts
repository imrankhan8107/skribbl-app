import { useEffect, useRef } from "react";
import type { GameState } from "../types";
import { soundManager } from "../utils/soundEffects";

/**
 * Hook that listens to GameState events and triggers corresponding synthesized sound effects
 */
export function useGameAudio(gameState: GameState) {
  const prevMessagesCountRef = useRef(gameState.chatMessages.length);
  const prevPhaseRef = useRef(gameState.phase);

  // 1. Play tick on countdown when remaining <= 10s
  useEffect(() => {
    if (
      gameState.phase === "playing" &&
      gameState.timerSeconds > 0 &&
      gameState.timerSeconds <= 10
    ) {
      soundManager.playTimerTick(gameState.timerSeconds);
    }
  }, [gameState.phase, gameState.timerSeconds]);

  // 2. Play audio on new chat events (correct guess or close guess)
  useEffect(() => {
    const currentCount = gameState.chatMessages.length;
    if (currentCount > prevMessagesCountRef.current) {
      const newMessages = gameState.chatMessages.slice(prevMessagesCountRef.current);
      for (const msg of newMessages) {
        if (msg.type === "correct_guess") {
          soundManager.playCorrectGuess(msg.senderName);
        } else if (msg.type === "system" && msg.text.toLowerCase().includes("close")) {
          soundManager.playCloseGuess();
        }
      }
    }
    prevMessagesCountRef.current = currentCount;
  }, [gameState.chatMessages]);

  // 3. Play audio on phase transitions
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const current = gameState.phase;

    if (prev !== current) {
      if (current === "playing") {
        soundManager.playRoundStart(gameState.currentRound);
      } else if (current === "game_over") {
        soundManager.playGameOver();
      }
      prevPhaseRef.current = current;
    }
  }, [gameState.phase, gameState.currentRound]);
}
