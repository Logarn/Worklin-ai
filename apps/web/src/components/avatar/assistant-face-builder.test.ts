import { describe, expect, test } from "bun:test";

import {
  buildCharacterPortraitPrompt,
  faceBuilderForCharacter,
} from "@/components/avatar/assistant-face-builder";

describe("faceBuilderForCharacter", () => {
  test("maps recognizable character presets into editable face parts", () => {
    expect(faceBuilderForCharacter("rick_and_morty", "rick")).toMatchObject({
      hair: "spiky",
      eyes: "sleepy",
      accessories: "lab",
      background: "portal",
    });

    expect(faceBuilderForCharacter("futurama", "leela")).toMatchObject({
      eyes: "one",
      hair: "swoop",
      background: "navy",
    });
  });

  test("falls back to a complete editable config for unknown characters", () => {
    expect(
      Object.keys(faceBuilderForCharacter("simpsons", "unknown")),
    ).toEqual([
      "skinTone",
      "hair",
      "eyes",
      "brows",
      "eyewear",
      "nose",
      "mouth",
      "accessories",
      "lineStyle",
      "background",
    ]);
  });
});

describe("buildCharacterPortraitPrompt", () => {
  test("creates a portrait prompt that can be pasted into an image generator", () => {
    const prompt = buildCharacterPortraitPrompt(
      "Spiky Spark",
      "Worklin",
    );

    expect(prompt).toContain("Spiky Spark");
    expect(prompt).toContain("product-avatar portrait");
    expect(prompt).toContain("no text");
  });
});
