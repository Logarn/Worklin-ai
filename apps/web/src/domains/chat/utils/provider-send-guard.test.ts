import { describe, expect, mock, test } from "bun:test";

import type { ProviderProfileRepairResult } from "@/assistant/provider-profile-repair";
import {
  checkProviderReadyForSend,
  type ProviderSendSelection,
} from "@/domains/chat/utils/provider-send-guard";
import type {
  AuthInfoGetResponse,
  ConfigGetResponse,
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

type Profile = NonNullable<
  NonNullable<ConfigGetResponse["llm"]>["profiles"]
>[string];
type Secret = SecretsGetResponse["secrets"][number];

function configWithProfiles(
  activeProfile: string,
  profiles: Record<string, Profile>,
): ConfigGetResponse {
  return {
    llm: {
      activeProfile,
      profiles,
    },
  };
}

function connection(
  name: string,
  provider: ProviderConnection["provider"],
  auth: ProviderConnection["auth"],
  isManaged = false,
): ProviderConnection {
  return {
    name,
    provider,
    auth,
    label: null,
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged,
  };
}

function dependencies(
  config: ConfigGetResponse,
  selection: ProviderSendSelection = { kind: "workspace-active" },
) {
  const loadConnections = mock(async () => [] as ProviderConnection[]);
  const loadSecrets = mock(async () => [] as Secret[]);
  const loadManagedStatus = mock(async (): Promise<AuthInfoGetResponse> => ({
    platformUrl: "https://platform.example.com",
    assistantId: "asst-1",
    organizationId: null,
    userId: null,
    authenticated: true,
  }));
  const repairActiveSelection = mock(
    async (): Promise<ProviderProfileRepairResult> => ({
      repaired: false,
      reason: "ambiguous",
    }),
  );

  return {
    selection,
    loadConfig: mock(async () => config),
    loadConnections,
    loadSecrets,
    loadManagedStatus,
    repairActiveSelection,
  };
}

const managedProfile: Profile = {
  source: "managed",
  provider: "anthropic",
  model: "claude-opus-4-8",
};

describe("checkProviderReadyForSend", () => {
  test("returns the exact verified workspace profile for the caller to pin on the send", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", { balanced: managedProfile }),
    );

    expect(await checkProviderReadyForSend(deps)).toEqual({
      allowed: true,
      reason: "managed-configured",
      profileName: "balanced",
    });
  });

  test("allows a ready API-key conversation override instead of checking the managed active profile", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", {
        balanced: managedProfile,
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
          provider_connection: "openai-personal",
        },
      }),
      { kind: "conversation-override", profileName: "personal" },
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("openai-personal", "openai", {
        type: "api_key",
        credential: "credential/openai/api_key",
      }),
    ]);
    deps.loadSecrets.mockImplementation(async () => [
      { type: "api_key", name: "openai" },
    ]);

    expect(await checkProviderReadyForSend(deps)).toEqual({
      allowed: true,
      reason: "personal-configured",
      profileName: "personal",
    });
    expect(deps.loadManagedStatus).not.toHaveBeenCalled();
  });

  test("allows a ready OAuth conversation override", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", {
        balanced: managedProfile,
        chatgpt: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4-mini",
          provider_connection: "chatgpt-subscription",
        },
      }),
      { kind: "conversation-override", profileName: "chatgpt" },
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("chatgpt-subscription", "openai", {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      }),
    ]);
    deps.loadSecrets.mockImplementation(async () => [
      { type: "credential", name: "chatgpt:access_token" },
    ]);

    expect(await checkProviderReadyForSend(deps)).toEqual({
      allowed: true,
      reason: "personal-configured",
      profileName: "chatgpt",
    });
    expect(deps.loadManagedStatus).not.toHaveBeenCalled();
  });

  test("repairs an unpinned active personal profile only after finding a ready compatible personal connection", async () => {
    const deps = dependencies(
      configWithProfiles("personal", {
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
        },
      }),
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("openai-managed", "openai", { type: "platform" }, true),
      connection("openai-personal", "openai", {
        type: "api_key",
        credential: "credential/openai/api_key",
      }),
    ]);
    deps.loadSecrets.mockImplementation(async () => [
      { type: "api_key", name: "openai" },
    ]);
    deps.repairActiveSelection.mockImplementation(async () => ({
      repaired: true,
      providerLabel: "OpenAI",
      verifiedProfileName: "personal",
    }));

    expect(await checkProviderReadyForSend(deps)).toEqual({
      allowed: true,
      reason: "personal-repaired",
      profileName: "personal",
    });
    expect(deps.repairActiveSelection).toHaveBeenCalledTimes(1);
    expect(deps.loadManagedStatus).not.toHaveBeenCalled();
  });

  test("blocks an unpinned personal conversation override when Any connection could select managed transport", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", {
        balanced: managedProfile,
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
        },
      }),
      { kind: "conversation-override", profileName: "personal" },
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("openai-managed", "openai", { type: "platform" }, true),
      connection("openai-personal", "openai", {
        type: "api_key",
        credential: "credential/openai/api_key",
      }),
    ]);
    deps.loadSecrets.mockImplementation(async () => [
      { type: "api_key", name: "openai" },
    ]);

    const result = await checkProviderReadyForSend(deps);

    expect(result).toMatchObject({
      allowed: false,
      reason: "personal-connection-required",
      action: "open-model-settings",
    });
    expect(result).toHaveProperty("message");
    expect(deps.repairActiveSelection).not.toHaveBeenCalled();
  });

  test("preserves an unpinned personal override when every compatible connection is ready and personal", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", {
        balanced: managedProfile,
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
        },
      }),
      { kind: "conversation-override", profileName: "personal" },
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("openai-primary", "openai", {
        type: "api_key",
        credential: "credential/openai/api_key",
      }),
      connection("openai-secondary", "openai", {
        type: "api_key",
        credential: "credential/openai/api_key",
      }),
    ]);
    deps.loadSecrets.mockImplementation(async () => [
      { type: "api_key", name: "openai" },
    ]);

    expect(await checkProviderReadyForSend(deps)).toEqual({
      allowed: true,
      reason: "personal-configured",
      profileName: "personal",
    });
    expect(deps.repairActiveSelection).not.toHaveBeenCalled();
  });

  test("fails closed with a Settings action when config cannot be verified", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", { balanced: managedProfile }),
    );
    deps.loadConfig.mockImplementation(async () => {
      throw new Error("temporary config read failure");
    });

    const result = await checkProviderReadyForSend(deps);

    expect(result).toMatchObject({
      allowed: false,
      reason: "config-unverified",
      action: "open-model-settings",
    });
    expect(result).toHaveProperty("message");
    expect(deps.loadManagedStatus).not.toHaveBeenCalled();
  });

  test("fails closed when the conversation selection cannot be verified", async () => {
    const selectionError = new Error("conversation read failed");
    const deps = dependencies(
      configWithProfiles("balanced", { balanced: managedProfile }),
      { kind: "unverified", error: selectionError },
    );

    expect(await checkProviderReadyForSend(deps)).toMatchObject({
      allowed: false,
      reason: "selection-unverified",
      action: "open-model-settings",
      error: selectionError,
    });
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });

  test("fails closed when personal connection state cannot be verified", async () => {
    const deps = dependencies(
      configWithProfiles("personal", {
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
          provider_connection: "openai-personal",
        },
      }),
    );
    deps.loadConnections.mockImplementation(async () => {
      throw new Error("connection route unavailable");
    });

    expect(await checkProviderReadyForSend(deps)).toMatchObject({
      allowed: false,
      reason: "connection-unverified",
      action: "open-model-settings",
    });
  });

  test("fails closed when a pinned connection is absent even if platform auth is available", async () => {
    const deps = dependencies(
      configWithProfiles("personal", {
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
          provider_connection: "deleted-personal-connection",
        },
      }),
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("openai-managed", "openai", { type: "platform" }, true),
    ]);

    expect(await checkProviderReadyForSend(deps)).toMatchObject({
      allowed: false,
      reason: "connection-unverified",
      action: "open-model-settings",
    });
    expect(deps.loadManagedStatus).not.toHaveBeenCalled();
    expect(deps.loadSecrets).not.toHaveBeenCalled();
  });

  test("checks configured status and fails closed for a managed selection", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", { balanced: managedProfile }),
    );
    deps.loadManagedStatus.mockImplementation(async () => {
      throw new Error("status route unavailable");
    });

    expect(await checkProviderReadyForSend(deps)).toMatchObject({
      allowed: false,
      reason: "managed-status-unverified",
      action: "open-model-settings",
    });
  });

  test("treats a legacy user profile pinned to platform auth as managed", async () => {
    const deps = dependencies(
      configWithProfiles("legacy", {
        legacy: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
          provider_connection: "openai-managed",
        },
      }),
    );
    deps.loadConnections.mockImplementation(async () => [
      connection("openai-managed", "openai", { type: "platform" }, true),
    ]);
    deps.loadManagedStatus.mockImplementation(async () => {
      throw new Error("status route unavailable");
    });

    expect(await checkProviderReadyForSend(deps)).toMatchObject({
      allowed: false,
      reason: "managed-status-unverified",
    });
  });

  test("repairs an unavailable managed workspace selection", async () => {
    const deps = dependencies(
      configWithProfiles("balanced", { balanced: managedProfile }),
    );
    deps.loadManagedStatus.mockImplementation(async () => ({
      platformUrl: null,
      assistantId: "asst-1",
      organizationId: null,
      userId: null,
      authenticated: false,
    }));
    deps.repairActiveSelection.mockImplementation(async () => ({
      repaired: true,
      providerLabel: "OpenAI",
      verifiedProfileName: "custom-balanced",
    }));

    expect(await checkProviderReadyForSend(deps)).toEqual({
      allowed: true,
      reason: "managed-repaired",
      profileName: "custom-balanced",
    });
  });

  test("does not repair an unavailable managed conversation override through the workspace active profile", async () => {
    const deps = dependencies(
      configWithProfiles("personal", {
        personal: {
          source: "user",
          provider: "openai",
          model: "gpt-5.4",
          provider_connection: "openai-personal",
        },
        balanced: managedProfile,
      }),
      { kind: "conversation-override", profileName: "balanced" },
    );
    deps.loadManagedStatus.mockImplementation(async () => ({
      platformUrl: null,
      assistantId: "asst-1",
      organizationId: null,
      userId: null,
      authenticated: false,
    }));

    expect(await checkProviderReadyForSend(deps)).toMatchObject({
      allowed: false,
      reason: "managed-unavailable",
      action: "open-model-settings",
    });
    expect(deps.repairActiveSelection).not.toHaveBeenCalled();
  });
});
