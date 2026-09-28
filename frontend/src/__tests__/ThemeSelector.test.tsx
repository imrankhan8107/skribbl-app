import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeSelector } from "../components/ThemeSelector";
import { THEMES } from "../utils/theme";

describe("ThemeSelector Component", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders with default theme button", () => {
    render(<ThemeSelector />);
    const button = screen.getByRole("button", { name: /toggle theme selector/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("Classic Light");
  });

  it("opens theme dropdown menu on click and lists all themes", async () => {
    const user = userEvent.setup();
    render(<ThemeSelector />);

    const button = screen.getByRole("button", { name: /toggle theme selector/i });
    await user.click(button);

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    for (const theme of THEMES) {
      expect(screen.getAllByText(new RegExp(theme.label, "i")).length).toBeGreaterThan(0);
    }
  });

  it("switches theme and sets data-theme attribute on documentElement", async () => {
    const user = userEvent.setup();
    render(<ThemeSelector />);

    const button = screen.getByRole("button", { name: /toggle theme selector/i });
    await user.click(button);

    const darkThemeBtn = screen.getByText(/Midnight Dark/i);
    await user.click(darkThemeBtn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("skribbl_theme")).toBe("dark");
  });
});
