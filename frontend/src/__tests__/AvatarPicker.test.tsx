import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvatarPicker } from "../components/AvatarPicker";
import { AVATARS } from "../utils/avatars";

describe("AvatarPicker Component", () => {
  it("renders with current selected avatar", () => {
    const handleSelect = vi.fn();
    render(<AvatarPicker selectedAvatarId="fox" onSelectAvatar={handleSelect} />);

    expect(screen.getByText("Choose Your Avatar")).toBeInTheDocument();
    expect(screen.getByText("Fox")).toBeInTheDocument();
  });

  it("calls onSelectAvatar when an avatar option is clicked", async () => {
    const user = userEvent.setup();
    const handleSelect = vi.fn();
    render(<AvatarPicker selectedAvatarId="fox" onSelectAvatar={handleSelect} />);

    const pandaBtn = screen.getByTitle("Panda");
    await user.click(pandaBtn);

    expect(handleSelect).toHaveBeenCalledWith("panda");
  });

  it("randomizes avatar when Shuffle button is clicked", async () => {
    const user = userEvent.setup();
    const handleSelect = vi.fn();
    render(<AvatarPicker selectedAvatarId="fox" onSelectAvatar={handleSelect} />);

    const shuffleBtn = screen.getByRole("button", { name: /shuffle/i });
    await user.click(shuffleBtn);

    expect(handleSelect).toHaveBeenCalled();
    const selectedId = handleSelect.mock.calls[0][0];
    expect(AVATARS.some((a) => a.id === selectedId)).toBe(true);
  });
});
