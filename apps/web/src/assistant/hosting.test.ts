import { describe, expect, test } from "bun:test";

import {
  filterHostedAssistants,
  firstHostedAssistant,
  isHostedAssistant,
} from "@/assistant/hosting";

describe("assistant hosting helpers", () => {
  test("treats is_local assistants as non-hosted", () => {
    expect(isHostedAssistant({ is_local: false })).toBe(true);
    expect(isHostedAssistant({ is_local: true })).toBe(false);
  });

  test("filters self-hosted assistants out of mixed platform lists", () => {
    const assistants = [
      { id: "self-hosted", is_local: true },
      { id: "hosted-a", is_local: false },
      { id: "hosted-b", is_local: false },
    ];

    expect(filterHostedAssistants(assistants)).toEqual([
      { id: "hosted-a", is_local: false },
      { id: "hosted-b", is_local: false },
    ]);
  });

  test("picks the first hosted assistant and ignores leading self-hosted rows", () => {
    const assistants = [
      { id: "self-hosted", is_local: true },
      { id: "hosted-a", is_local: false },
    ];

    expect(firstHostedAssistant(assistants)).toEqual({
      id: "hosted-a",
      is_local: false,
    });
    expect(firstHostedAssistant([{ id: "self-hosted", is_local: true }])).toBe(
      null,
    );
  });
});
