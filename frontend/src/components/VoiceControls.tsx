import { useEffect, useRef, useState } from "react";
import { useVoiceChat } from "../context/VoiceChatContext";

export function VoiceControls() {
  const {
    inVoice,
    isMuted,
    voiceError,
    peerCount,
    inputDevices,
    outputDevices,
    selectedInputId,
    selectedOutputId,
    outputVolume,
    supportsOutputSelection,
    joinVoice,
    leaveVoice,
    toggleMute,
    setInputDevice,
    setOutputDevice,
    setOutputVolume,
    refreshDevices,
    clearVoiceError,
  } = useVoiceChat();

  const [showSettings, setShowSettings] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSettings) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSettings]);

  const handleToggleSettings = () => {
    const next = !showSettings;
    setShowSettings(next);
    if (next) {
      void refreshDevices();
    }
  };

  return (
    <div className="voice-controls" data-testid="voice-controls" ref={containerRef}>
      {!inVoice ? (
        <button
          type="button"
          className="voice-btn"
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
            className={`voice-btn ${isMuted ? "voice-btn-muted" : "voice-btn-active"}`}
            data-testid="voice-mute-btn"
            onClick={toggleMute}
            title={isMuted ? "Unmute microphone" : "Mute microphone"}
          >
            {isMuted ? "🔇 Unmute" : "🎙️ Mute"}
          </button>
          <button
            type="button"
            className="voice-btn voice-btn-danger"
            data-testid="voice-leave-btn"
            onClick={leaveVoice}
            title="Leave voice chat"
          >
            📞 Leave
          </button>
        </>
      )}

      <button
        type="button"
        className={`voice-settings-btn ${showSettings ? "active" : ""}`}
        data-testid="voice-settings-btn"
        onClick={handleToggleSettings}
        title="Audio settings (microphone, speaker, volume)"
        aria-label="Audio settings"
      >
        ⚙️
      </button>

      {showSettings && (
        <div className="voice-settings-popover" data-testid="voice-settings-popover">
          <div className="voice-settings-header">
            <span>🎧 Audio Settings</span>
            <button
              type="button"
              className="voice-refresh-btn"
              onClick={() => void refreshDevices()}
              title="Refresh audio devices"
            >
              🔄
            </button>
          </div>

          <div className="voice-setting-group">
            <label htmlFor="voice-input-select">Microphone (Input)</label>
            <select
              id="voice-input-select"
              data-testid="voice-input-select"
              value={selectedInputId}
              onChange={(e) => void setInputDevice(e.target.value)}
            >
              {inputDevices.length === 0 ? (
                <option value="">Default Microphone</option>
              ) : (
                inputDevices.map((dev) => (
                  <option key={dev.deviceId} value={dev.deviceId}>
                    {dev.label}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="voice-setting-group">
            <label htmlFor="voice-output-select">Speaker (Output)</label>
            {supportsOutputSelection ? (
              <select
                id="voice-output-select"
                data-testid="voice-output-select"
                value={selectedOutputId}
                onChange={(e) => void setOutputDevice(e.target.value)}
              >
                {outputDevices.length === 0 ? (
                  <option value="">Default Speaker</option>
                ) : (
                  outputDevices.map((dev) => (
                    <option key={dev.deviceId} value={dev.deviceId}>
                      {dev.label}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <span className="voice-setting-note">
                Output device selection uses system default in this browser.
              </span>
            )}
          </div>

          <div className="voice-setting-group">
            <div className="voice-volume-header">
              <label htmlFor="voice-volume-slider">Speaker Volume</label>
              <span className="voice-volume-value">{outputVolume}%</span>
            </div>
            <input
              id="voice-volume-slider"
              data-testid="voice-volume-slider"
              type="range"
              min={0}
              max={100}
              value={outputVolume}
              onChange={(e) => setOutputVolume(Number(e.target.value))}
            />
          </div>
        </div>
      )}

      {voiceError && (
        <span
          className="voice-error-text"
          data-testid="voice-error"
          onClick={clearVoiceError}
          title="Click to dismiss"
        >
          {voiceError}
        </span>
      )}
    </div>
  );
}
