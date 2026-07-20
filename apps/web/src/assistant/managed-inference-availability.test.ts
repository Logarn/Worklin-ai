import { describe, expect, test } from "bun:test";

import {
  connectionsAvailableForManagedInference,
  isManagedInferenceProfile,
  profilesAvailableForManagedInference,
} from "@/assistant/managed-inference";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

function connection(
  name: string,
  auth: ProviderConnection["auth"],
  isManaged = false,
): ProviderConnection {
  return {
    name,
    provider: "anthropic",
    auth,
    label: null,
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged,
  };
}

const managedConnection = connection(
  "anthropic-managed",
  { type: "platform" },
  true,
);
const personalConnection = connection("anthropic-personal", {
  type: "api_key",
  credential: "credential/anthropic/api_key",
});

describe("managed inference availability filters", () => {
  test("removes managed and platform connections when availability is not confirmed", () => {
    expect(
      connectionsAvailableForManagedInference(
        [managedConnection, personalConnection],
        false,
      ).map((candidate) => candidate.name),
    ).toEqual(["anthropic-personal"]);
  });

  test("recognizes both seeded managed profiles and user profiles bound to platform auth", () => {
    expect(isManagedInferenceProfile({ source: "managed" })).toBe(true);
    expect(
      isManagedInferenceProfile(
        {
          source: "user",
          provider_connection: "anthropic-managed",
        },
        [managedConnection],
      ),
    ).toBe(true);
    expect(
      isManagedInferenceProfile(
        {
          source: "user",
          provider_connection: "anthropic-personal",
        },
        [personalConnection],
      ),
    ).toBe(false);
  });

  test("preserves managed profiles when the daemon confirms platform auth", () => {
    const profiles = [
      { name: "balanced", source: "managed" as const },
      {
        name: "personal",
        source: "user" as const,
        provider_connection: "anthropic-personal",
      },
    ];

    expect(
      profilesAvailableForManagedInference(
        profiles,
        [managedConnection, personalConnection],
        true,
      ),
    ).toEqual(profiles);
  });
});
