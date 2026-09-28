import { useRef, useEffect, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import type { ChatMessage } from "../types";
import { getAvatarForPlayer, getStoredAvatarId, getStoredPlayerName } from "../utils/avatars";
import { triggerGlobalConfetti } from "./Confetti";

/**
 * Chat component — scrollable message feed + guess/chat input.
 * Guessers send 'guess' messages; Drawer sends 'chat' messages.
 * Input is disabled when isDrawer or hasGuessed is true.
 * Requirements: 6.1, 6.3, 6.5, 6.8
 */
export default function Chat() {
  const { gameState, send } = useWebSocket();
  const [text, setText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesCountRef = useRef(gameState.chatMessages.length);

  // Auto-scroll to bottom when new messages arrive and trigger confetti on correct guess
  useEffect(() => {
    if (messagesEndRef.current && messagesEndRef.current.scrollIntoView) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }

    if (gameState.chatMessages.length > prevMessagesCountRef.current) {
      const newMessages = gameState.chatMessages.slice(prevMessagesCountRef.current);
      for (const msg of newMessages) {
        if (msg.type === "correct_guess") {
          triggerGlobalConfetti();
        }
      }
    }
    prevMessagesCountRef.current = gameState.chatMessages.length;
  }, [gameState.chatMessages]);

  const isInputDisabled = gameState.hasGuessed;
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    if (gameState.phase === "playing" && !gameState.isDrawer && !gameState.hasGuessed) {
      send("typing", { is_typing: true });
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        send("typing", { is_typing: false });
      }, 1500);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (gameState.phase === "playing" && !gameState.isDrawer && !gameState.hasGuessed) {
      send("typing", { is_typing: false });
    }

    if (gameState.phase === "lobby") {
      // In lobby, all messages are just chat
      send("chat", { text: trimmed });
    } else if (gameState.isDrawer) {
      send("chat", { text: trimmed });
    } else {
      send("guess", { text: trimmed });
    }
    setText("");
  };

  const getMessageClassName = (msg: ChatMessage): string => {
    const classes = ["chat-message"];
    if (msg.type === "system") classes.push("chat-system");
    if (msg.type === "correct_guess") classes.push("chat-correct-guess");
    return classes.join(" ");
  };

  return (
    <div className="chat-container" data-testid="chat-container">
      <div className="chat-messages" data-testid="chat-messages">
        {gameState.chatMessages.map((msg) => {
          const sender = gameState.players.find(
            (p) => p.id === msg.senderId || p.name === msg.senderName
          );
          const isLocal =
            (gameState.localPlayerId && msg.senderId === gameState.localPlayerId) ||
            msg.senderName === getStoredPlayerName();
          const explicitAvatar = sender?.avatar || (isLocal ? getStoredAvatarId() : undefined);
          const avatar = getAvatarForPlayer(msg.senderName || msg.senderId, explicitAvatar);
          return (
            <div
              key={msg.id}
              className={getMessageClassName(msg)}
              data-testid={`chat-msg-${msg.type}`}
            >
              {msg.type === "chat" && (
                <>
                  <span
                    className="chat-avatar-badge"
                    style={{ backgroundColor: avatar.bgColor }}
                    title={avatar.label}
                  >
                    {avatar.emoji}
                  </span>
                  <span className="chat-sender">{msg.senderName}:</span>{" "}
                  <span className="chat-text">{msg.text}</span>
                </>
              )}
              {msg.type === "correct_guess" && (
                <>
                  <span className="chat-star-icon">🌟</span>{" "}
                  <span className="chat-text">{msg.text}</span>
                </>
              )}
              {msg.type === "system" && <span className="chat-text">{msg.text}</span>}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing indicator */}
      {(() => {
        const typingList = Object.entries(gameState.typingUsers || {})
          .filter(([id, isTyping]) => isTyping && id !== gameState.localPlayerId)
          .map(([id]) => gameState.players.find((p) => p.id === id)?.name || "Someone");
        if (typingList.length === 0) return null;
        const statusText =
          typingList.length === 1
            ? `${typingList[0]} is guessing...`
            : `${typingList.slice(0, 2).join(", ")} are guessing...`;
        return (
          <div className="chat-typing-status" data-testid="chat-typing-status">
            <span className="typing-dot-pulse">✏️</span> {statusText}
          </div>
        );
      })()}

      <form className="chat-input-form" onSubmit={handleSubmit} data-testid="chat-form">
        <input
          type="text"
          value={text}
          onChange={handleInputChange}
          disabled={isInputDisabled}
          placeholder={
            gameState.phase === "lobby"
              ? "Chat with other players..."
              : gameState.isDrawer
                ? "Chat (word will be hidden)..."
                : gameState.hasGuessed
                  ? "You already guessed!"
                  : "Type your guess..."
          }
          data-testid="chat-input"
          aria-label="Chat input"
        />
        <button type="submit" disabled={isInputDisabled} data-testid="chat-submit">
          Send
        </button>
      </form>

      <div className="emoji-reactions" data-testid="emoji-reactions">
        {["👍", "😂", "🔥", "❤️", "👏", "😮"].map((emoji) => (
          <button
            key={emoji}
            className="emoji-btn"
            onClick={() => send("reaction", { emoji })}
            aria-label={`React with ${emoji}`}
            data-testid={`emoji-btn-${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
