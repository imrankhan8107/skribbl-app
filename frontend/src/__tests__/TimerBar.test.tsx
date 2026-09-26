import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TimerBar from "../components/TimerBar";

describe("TimerBar Component", () => {
  it("renders remaining seconds", () => {
    render(<TimerBar seconds={45} total={80} />);
    expect(screen.getByTestId("timer-bar-text")).toHaveTextContent("45s");
    expect(screen.getByTestId("timer-bar")).not.toHaveClass("urgent");
  });

  it("applies urgent class when seconds <= 10", () => {
    render(<TimerBar seconds={8} total={80} />);
    const timerBar = screen.getByTestId("timer-bar");
    expect(timerBar).toHaveClass("urgent");
    expect(screen.getByTestId("timer-bar-text")).toHaveTextContent("8s");
  });

  it("does not apply urgent class when seconds is 0", () => {
    render(<TimerBar seconds={0} total={80} />);
    const timerBar = screen.getByTestId("timer-bar");
    expect(timerBar).not.toHaveClass("urgent");
  });
});
