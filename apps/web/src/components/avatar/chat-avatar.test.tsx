import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentPropsWithoutRef } from "react";

import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

mock.module("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentPropsWithoutRef<"div">) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => true,
}));

mock.module("@/components/avatar/portrait-asset-avatar", () => ({
  PortraitAssetAvatar: ({ alt }: { alt?: string }) => (
    <div data-testid="portrait-avatar">{alt ?? "portrait"}</div>
  ),
}));

mock.module("@/components/avatar/face-builder-avatar", () => ({
  FaceBuilderAvatar: ({ label }: { label?: string }) => (
    <div data-testid="face-builder-avatar">{label ?? "face-builder"}</div>
  ),
}));

mock.module("@/components/avatar/tv-character-avatar", () => ({
  TvCharacterAvatar: ({ label }: { label?: string }) => (
    <div data-testid="tv-avatar">{label ?? "tv-avatar"}</div>
  ),
}));

const { ChatAvatar } = await import("./chat-avatar");

const components: CharacterComponents = {
  bodyShapes: [
    {
      id: "blob",
      viewBox: { width: 100, height: 100 },
      faceCenter: { x: 50, y: 50 },
      svgPath: "M 0 0",
    },
  ],
  eyeStyles: [
    {
      id: "sleepy",
      sourceViewBox: { width: 20, height: 20 },
      eyeCenter: { x: 10, y: 10 },
      paths: [{ svgPath: "M 0 0", color: "#000" }],
    },
  ],
  colors: [{ id: "green", hex: "#00ff00" }],
  faceCenterOverrides: [],
};

const traits: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "sleepy",
  color: "green",
};

const profileWithPortrait: AssistantCharacterProfile = {
  assistantName: "Spiky Spark",
  characterPackId: "worklin",
  characterId: "spiky_spark",
  avatarStyle: "portrait_asset",
  portraitAssetUrl: "/images/avatars/spiky-spark.mp4",
  personalityPreset: "playful",
  personalityText: "Playful confidence.",
  role: "creative partner",
  tone: "Sharp.",
  bio: "Bio",
  animationEnabled: true,
  updatedAt: "2026-07-11T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
});

describe("ChatAvatar", () => {
  test("prefers an uploaded image over a saved portrait asset", () => {
    render(
      <ChatAvatar
        components={components}
        traits={null}
        customImageUrl="blob:uploaded-avatar"
        characterProfile={profileWithPortrait}
      />,
    );

    const image = screen.getByAltText("Assistant avatar");
    expect(image.getAttribute("src")).toBe("blob:uploaded-avatar");
    expect(screen.queryByTestId("portrait-avatar")).toBeNull();
  });

  test("maps legacy abstract profiles to the Worklin orb", () => {
    render(
      <ChatAvatar
        components={components}
        traits={traits}
        customImageUrl={null}
        characterProfile={{ ...profileWithPortrait, avatarStyle: "abstract" }}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Worklin assistant" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("portrait-avatar")).toBeNull();
  });
});
