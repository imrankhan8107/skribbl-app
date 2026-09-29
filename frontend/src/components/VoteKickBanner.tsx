import { useWebSocket } from "../hooks/useWebSocket";

export default function VoteKickBanner() {
  const { gameState, send } = useWebSocket();
  const active = gameState.activeVoteKick;

  if (!active) return null;

  const isTarget = active.targetId === gameState.localPlayerId;
  const hasVoted = active.hasVoted;

  return (
    <div
      className="vote-kick-banner"
      data-testid="vote-kick-banner"
      style={{
        backgroundColor: "var(--color-surface, #1e293b)",
        color: "var(--color-text, #f8fafc)",
        padding: "10px 16px",
        borderRadius: "8px",
        margin: "8px 0 12px 0",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "12px",
        border: "2px solid #ef4444",
        boxShadow: "0 4px 12px rgba(239, 68, 68, 0.25)",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span style={{ fontSize: "22px" }}>🗳️</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: "14px" }}>
            Vote to Kick: <span style={{ color: "#f87171" }}>{active.targetName}</span>
          </div>
          <div style={{ fontSize: "12px", opacity: 0.85 }}>
            Initiated by {active.initiatorName} • Votes:{" "}
            <strong>
              {active.currentVotes} / {active.requiredVotes}
            </strong>{" "}
            required
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {isTarget ? (
          <span
            style={{ fontSize: "13px", color: "#fca5a5", fontStyle: "italic" }}
            data-testid="vote-kick-target-msg"
          >
            ⚠️ You are being voted to be kicked ({active.currentVotes}/{active.requiredVotes})
          </span>
        ) : hasVoted ? (
          <span
            style={{ fontSize: "13px", color: "#86efac", fontWeight: 600 }}
            data-testid="vote-kick-voted-msg"
          >
            ✓ You voted YES ({active.currentVotes}/{active.requiredVotes})
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-danger"
              data-testid="vote-kick-yes-btn"
              onClick={() => send("vote_kick_cast", { vote: true })}
              style={{
                backgroundColor: "#dc2626",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                padding: "6px 12px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ✓ Vote Kick ({active.currentVotes}/{active.requiredVotes})
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="vote-kick-no-btn"
              onClick={() => send("vote_kick_cast", { vote: false })}
              style={{
                backgroundColor: "#475569",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                padding: "6px 10px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ✕ No
            </button>
          </>
        )}
      </div>
    </div>
  );
}
