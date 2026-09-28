import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PlayerList from "../components/PlayerList";
import type { PlayerInfo } from "../types";

describe("PlayerList Badges & Indicators", () => {
  const mockPlayers: PlayerInfo[] = [
    {
      id: "p1",
      name: "Alice",
      score: 450,
      isHost: true,
      hasGuessed: true,
      isConnected: true,
      isReady: true,
      streak: 3,
      isFirstGuesser: true,
    },
    {
      id: "p2",
      name: "Bob",
      score: 200,
      isHost: false,
      hasGuessed: false,
      isConnected: true,
      isReady: true,
      streak: 0,
      isFirstGuesser: false,
    },
  ];

  it("renders streak badge and first guesser badge for qualified players", () => {
    render(<PlayerList players={mockPlayers} />);

    expect(screen.getByTestId("player-first-badge")).toHaveTextContent("⚡1st");
    expect(screen.getByTestId("player-streak-badge")).toHaveTextContent("🔥3");
  });

  it("renders typing indicator when typingUsers has active typer", () => {
    render(
      <PlayerList
        players={mockPlayers}
        typingUsers={{
          p2: true,
        }}
      />
    );

    expect(screen.getByTestId("player-typing")).toBeInTheDocument();
  });

  it("renders edit profile button for local player when onEditProfile is provided and fires onClick", () => {
    const onEditProfile = vi.fn();
    render(<PlayerList players={mockPlayers} localPlayerId="p1" onEditProfile={onEditProfile} />);

    const editBtn = screen.getByTestId("player-edit-profile-btn");
    expect(editBtn).toBeInTheDocument();
    editBtn.click();
    expect(onEditProfile).toHaveBeenCalledTimes(1);
  });
});
