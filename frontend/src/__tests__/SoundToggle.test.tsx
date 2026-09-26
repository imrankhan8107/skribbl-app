import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SoundToggle } from "../components/SoundToggle";
import { soundManager } from "../utils/soundEffects";

describe("SoundToggle Component", () => {
  beforeEach(() => {
    localStorage.clear();
    soundManager.setMuted(false);
  });

  it("renders with Sound On state by default", () => {
    render(<SoundToggle />);
    const button = screen.getByRole("button", { name: /mute game sounds/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("🔊");
    expect(button).toHaveTextContent("Sound On");
  });

  it("toggles to Muted when clicked", () => {
    render(<SoundToggle />);
    const button = screen.getByRole("button", { name: /mute game sounds/i });
    fireEvent.click(button);

    expect(soundManager.isMuted()).toBe(true);
    expect(button).toHaveTextContent("🔇");
    expect(button).toHaveTextContent("Muted");
  });

  it("toggles back to Sound On when clicked again", () => {
    render(<SoundToggle />);
    const button = screen.getByRole("button", { name: /mute game sounds/i });
    // First click: mute
    fireEvent.click(button);
    expect(soundManager.isMuted()).toBe(true);

    // Second click: unmute
    fireEvent.click(button);
    expect(soundManager.isMuted()).toBe(false);
    expect(button).toHaveTextContent("🔊");
    expect(button).toHaveTextContent("Sound On");
  });
});
