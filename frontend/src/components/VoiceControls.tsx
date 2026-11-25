import { useVoiceChat } from "../context/VoiceChatContext";

export function VoiceControls() {
  const {
    inVoice,
    isMuted,
    voiceError,
    peerCount,
    joinVoice,
    leaveVoice,
    toggleMute,
    clearVoiceError,
  } = useVoiceChat();

  return (
    <div
      className="voice-controls"
      data-testid="voice-controls"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
      }}
    >
      {!inVoice ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm voice-join-btn"
          data-testid="voice-join-btn"
          onClick={() => void joinVoice()}
          title="Join peer-to-peer room voice chat"
        >
          🎙️ Join Voice{peerCount > 0 ? ` (${peerCount})` : ""}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={`btn btn-sm ${isMuted ? "btn-warning" : "btn-primary"}`}
            data-testid="voice-mute-btn"
            onClick={toggleMute}
          >
            {isMuted ? "🔇 Unmute" : "🎙️ Mute"}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            data-testid="voice-leave-btn"
            onClick={leaveVoice}
          >
            Leave Voice
          </button>
        </>
      )}

      {voiceError && (
        <span
          className="voice-error-text"
          data-testid="voice-error"
          onClick={clearVoiceError}
          style={{
            color: "var(--color-danger, #dc3545)",
            fontSize: "0.8rem",
            cursor: "pointer",
          }}
        >
          {voiceError}
        </span>
      )}
    </div>
  );
}
