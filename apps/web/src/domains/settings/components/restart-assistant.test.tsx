import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const restartAssistantMock = mock(async () => ({ ok: true, data: {} }));

mock.module("@/assistant/api", () => ({
  restartAssistant: restartAssistantMock,
}));

const { RestartAssistant } = await import("./restart-assistant");

afterEach(() => {
  cleanup();
  restartAssistantMock.mockClear();
});

afterAll(() => {
  mock.restore();
});

describe("RestartAssistant", () => {
  test("does not open or submit the restart flow when capability is unavailable", () => {
    render(<RestartAssistant assistantId="assistant-1" disabled />);

    const button = screen.getByRole("button", { name: "Restart" });
    expect(button.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(button);

    expect(screen.queryByText("Restart Assistant")).toBeNull();
    expect(restartAssistantMock).not.toHaveBeenCalled();
  });
});
