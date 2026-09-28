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

  it("renders spectator badge for spectator players and does not show transfer host crown button", () => {
    const playersWithSpectator: PlayerInfo[] = [
      ...mockPlayers,
      {
        id: "p3",
        name: "Charlie",
        score: 0,
        isHost: false,
        hasGuessed: false,
        isConnected: true,
        isReady: false,
        isSpectator: true,
      },
    ];

    const onTransferHost = vi.fn();
    render(
      <PlayerList
        players={playersWithSpectator}
        isHost={true}
        localPlayerId="p1"
        onTransferHost={onTransferHost}
      />
    );

    expect(screen.getByTestId("spectator-badge")).toHaveTextContent("👀 Spectating");
    // Bob (active player) has crown button
    expect(screen.getByTestId("transfer-host-p2")).toBeInTheDocument();
    // Charlie (spectator) does NOT have crown button
    expect(screen.queryByTestId("transfer-host-p3")).not.toBeInTheDocument();
  });
});
