import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReactionToolbar, { REACTION_EMOJIS } from "../components/ReactionToolbar";
import { subscribeReaction, publishReaction } from "../context/reactionBus";

describe("ReactionToolbar & reactionBus", () => {
  it("renders all reaction emoji buttons", () => {
    const onReact = vi.fn();
    render(<ReactionToolbar onReact={onReact} />);

    expect(screen.getByTestId("reaction-toolbar")).toBeInTheDocument();
    for (const { label } of REACTION_EMOJIS) {
      const btn = screen.getByTitle(label);
      expect(btn).toBeInTheDocument();
    }
  });

  it("calls onReact with selected emoji when clicked", async () => {
    const user = userEvent.setup();
    const onReact = vi.fn();
    render(<ReactionToolbar onReact={onReact} />);

    const fireBtn = screen.getByTitle("Fire");
    await user.click(fireBtn);

    expect(onReact).toHaveBeenCalledWith("🔥");
  });

  it("does not call onReact when disabled", async () => {
    const user = userEvent.setup();
    const onReact = vi.fn();
    render(<ReactionToolbar onReact={onReact} disabled={true} />);

    const clapBtn = screen.getByTitle("Clap");
    await user.click(clapBtn);

    expect(onReact).not.toHaveBeenCalled();
  });

  it("reactionBus correctly publishes and delivers events to subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReaction(listener);

    const event = {
      id: "test-1",
      emoji: "🔥",
      playerName: "Alice",
      xPercent: 50,
      createdAt: Date.now(),
    };

    publishReaction(event);
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    publishReaction({ ...event, id: "test-2" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
