import { useRef, useEffect, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import type { ChatMessage } from "../types";

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

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current && messagesEndRef.current.scrollIntoView) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [gameState.chatMessages]);

  const isInputDisabled = gameState.hasGuessed;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;

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
        {gameState.chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={getMessageClassName(msg)}
            data-testid={`chat-msg-${msg.type}`}
          >
            {msg.type === "chat" && (
              <>
                <span className="chat-sender">{msg.senderName}:</span>{" "}
                <span className="chat-text">{msg.text}</span>
              </>
            )}
            {msg.type === "correct_guess" && (
              <span className="chat-text">{msg.text}</span>
            )}
            {msg.type === "system" && (
              <span className="chat-text">{msg.text}</span>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form
        className="chat-input-form"
        onSubmit={handleSubmit}
        data-testid="chat-form"
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
        <button
          type="submit"
          disabled={isInputDisabled}
          data-testid="chat-submit"
        >
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
