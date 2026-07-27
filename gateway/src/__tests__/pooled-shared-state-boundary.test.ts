import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { clearRemoteFeatureFlagStoreCache } from "../feature-flag-remote-store.js";
import {
  clearFeatureFlagStoreCache,
  writeFeatureFlag,
} from "../feature-flag-store.js";
import { loadFeatureFlagDefaults } from "../feature-flag-defaults.js";
import { readEnvFeatureFlagOverrides } from "../feature-flag-env-overrides.js";
import {
  createConversationThresholdDeleteHandler,
  createConversationThresholdGetHandler,
  createConversationThresholdPutHandler,
  createGlobalThresholdGetHandler,
  createGlobalThresholdPutHandler,
} from "../http/routes/auto-approve-thresholds.js";
import {
  createFeatureFlagsGetHandler,
  createFeatureFlagsPatchHandler,
} from "../http/routes/feature-flags.js";
import { createAgentCardHandler } from "../http/routes/a2a-routes.js";
import { handleCreateToken } from "../http/routes/auth-token.js";
import { createChannelVerificationSessionProxyHandler } from "../http/routes/channel-verification-session-proxy.js";
import { handleContactPromptSubmit } from "../http/routes/contact-prompt.js";
import { createContactsControlPlaneProxyHandler } from "../http/routes/contacts-control-plane-proxy.js";
import {
  handleListDevices,
  handleRevokeDevice,
} from "../http/routes/devices.js";
import { createGuardianChannelHandler } from "../http/routes/guardian-channel-create.js";
import { handlePair } from "../http/routes/pair.js";
import {
  createPrivacyConfigGetHandler,
  createPrivacyConfigPatchHandler,
} from "../http/routes/privacy-config.js";
import {
  createTrustRulesCreateHandler,
  createTrustRulesDeleteHandler,
  createTrustRulesListHandler,
  createTrustRulesResetHandler,
  createTrustRulesSuggestHandler,
  createTrustRulesUpdateHandler,
} from "../http/routes/trust-rules.js";
import {
  featureFlagRoutes,
  getMergedFeatureFlags,
} from "../ipc/feature-flag-handlers.js";
import { contactRoutes } from "../ipc/contact-handlers.js";
import { slackThreadRoutes } from "../ipc/slack-thread-handlers.js";
import { thresholdRoutes } from "../ipc/threshold-handlers.js";
import { trustRulesRoutes } from "../ipc/trust-rules-handlers.js";
import {
  POOLED_SHARED_STATE_ERROR_CODE,
  rejectPooledSharedStateAccess,
} from "../pooled-runtime-shared-state.js";
import {
  getTrustRuleCache,
  initTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import { testWorkspaceDir } from "./test-preload.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
const configPath = join(testWorkspaceDir, "config.json");

function useIsolatedRuntime(): void {
  process.env.WORKLIN_RUNTIME_MODE = "isolated";
  delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
}

function usePooledRuntime(): void {
  process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
  process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-shared-state-test";
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://gateway.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function ipcRoute(method: string) {
  const route = [...thresholdRoutes, ...trustRulesRoutes].find(
    (candidate) => candidate.method === method,
  );
  if (!route) throw new Error(`Missing IPC route ${method}`);
  return route;
}

function featureFlagIpcRoute(method: string) {
  const route = featureFlagRoutes.find(
    (candidate) => candidate.method === method,
  );
  if (!route) throw new Error(`Missing feature flag IPC route ${method}`);
  return route;
}

function sharedStateIpcRoute(method: string) {
  const route = [...contactRoutes, ...slackThreadRoutes].find(
    (candidate) => candidate.method === method,
  );
  if (!route) throw new Error(`Missing shared-state IPC route ${method}`);
  return route;
}

beforeEach(async () => {
  useIsolatedRuntime();
  resetGatewayDb();
  resetTrustRuleCache();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
  rmSync(configPath, { force: true });
  await initGatewayDb();
  initTrustRuleCache();
});

afterEach(() => {
  resetTrustRuleCache();
  resetGatewayDb();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
  rmSync(configPath, { force: true });
  if (originalRuntimeMode === undefined) {
    delete process.env.WORKLIN_RUNTIME_MODE;
  } else {
    process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  }
  if (originalWorkerStackId === undefined) {
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
  } else {
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = originalWorkerStackId;
  }
});

describe("pooled gateway shared-state boundary", () => {
  test("tenant A cannot loosen tenant B approval behavior over HTTP or IPC", async () => {
    const globalPut = createGlobalThresholdPutHandler();
    const globalGet = createGlobalThresholdGetHandler();
    const conversationPut = createConversationThresholdPutHandler();
    const conversationGet = createConversationThresholdGetHandler();
    const conversationDelete = createConversationThresholdDeleteHandler();

    expect(
      (
        await globalPut(
          request("/v1/permissions/thresholds", "PUT", {
            interactive: "high",
            autonomous: "high",
            headless: "high",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await conversationPut(
          request(
            "/v1/permissions/thresholds/conversations/shared-conversation",
            "PUT",
            { threshold: "high" },
          ),
          ["shared-conversation"],
        )
      ).status,
    ).toBe(200);

    usePooledRuntime();

    expect(
      await (await globalGet(request("/v1/permissions/thresholds"))).json(),
    ).toEqual({
      interactive: "none",
      autonomous: "none",
      headless: "none",
    });
    expect(
      await (
        await conversationGet(
          request(
            "/v1/permissions/thresholds/conversations/shared-conversation",
          ),
          ["shared-conversation"],
        )
      ).json(),
    ).toEqual({ threshold: "none" });

    expect(await ipcRoute("get_global_thresholds").handler()).toEqual({
      interactive: "none",
      autonomous: "none",
      headless: "none",
    });
    expect(
      await ipcRoute("get_conversation_threshold").handler({
        conversationId: "shared-conversation",
      }),
    ).toEqual({ threshold: "none" });
    expect(() =>
      ipcRoute("set_conversation_threshold").handler({
        conversationId: "shared-conversation",
        threshold: "high",
      }),
    ).toThrow(POOLED_SHARED_STATE_ERROR_CODE);

    const rejectedGlobalWrite = await globalPut(
      request("/v1/permissions/thresholds", "PUT", {
        interactive: "low",
      }),
    );
    expect(rejectedGlobalWrite.status).toBe(503);
    expect(await rejectedGlobalWrite.json()).toMatchObject({
      code: POOLED_SHARED_STATE_ERROR_CODE,
    });
    const rejectedConversationWrite = await conversationPut(
      request(
        "/v1/permissions/thresholds/conversations/shared-conversation",
        "PUT",
        { threshold: "low" },
      ),
      ["shared-conversation"],
    );
    expect(rejectedConversationWrite.status).toBe(503);
    expect(
      (
        await conversationDelete(
          request(
            "/v1/permissions/thresholds/conversations/shared-conversation",
            "DELETE",
          ),
          ["shared-conversation"],
        )
      ).status,
    ).toBe(503);

    useIsolatedRuntime();
    expect(
      await (await globalGet(request("/v1/permissions/thresholds"))).json(),
    ).toMatchObject({ interactive: "high" });
    expect(
      await (
        await conversationGet(
          request(
            "/v1/permissions/thresholds/conversations/shared-conversation",
          ),
          ["shared-conversation"],
        )
      ).json(),
    ).toEqual({ threshold: "high" });
  });

  test("pooled trust-rule reads are empty and every mutation path is disabled", async () => {
    const create = createTrustRulesCreateHandler();
    const update = createTrustRulesUpdateHandler();
    const remove = createTrustRulesDeleteHandler();
    const reset = createTrustRulesResetHandler();
    const list = createTrustRulesListHandler();
    const suggest = createTrustRulesSuggestHandler();
    const created = await create(
      request("/v1/trust-rules", "POST", {
        tool: "bash",
        pattern: "tenant-a-command",
        risk: "low",
        description: "tenant A private description",
      }),
    );
    expect(created.status).toBe(201);
    expect(
      getTrustRuleCache().findBaseRisk("bash", "tenant-a-command"),
    ).not.toBeNull();

    usePooledRuntime();

    const pooledList = await list(request("/v1/trust-rules?include_all=true"));
    expect(await pooledList.json()).toEqual({ rules: [] });
    expect(
      await ipcRoute("trust_rules_list").handler({ include_all: true }),
    ).toEqual({ rules: [] });
    expect(
      getTrustRuleCache().findBaseRisk("bash", "tenant-a-command"),
    ).toBeNull();

    const rejectedCreate = await create(
      request("/v1/trust-rules", "POST", {
        tool: "bash",
        pattern: "tenant-b-command",
        risk: "low",
        description: "must not persist",
      }),
    );
    expect(rejectedCreate.status).toBe(503);
    expect(
      (
        await update(
          request("/v1/trust-rules/tenant-a-rule", "PATCH", {
            risk: "high",
          }),
          "tenant-a-rule",
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await remove(
          request("/v1/trust-rules/tenant-a-rule", "DELETE"),
          "tenant-a-rule",
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await reset(
          request("/v1/trust-rules/tenant-a-rule/reset", "POST"),
          "tenant-a-rule",
        )
      ).status,
    ).toBe(503);
    const rejectedSuggestion = await suggest(
      request("/v1/trust-rules/suggest", "POST", {}),
    );
    expect(rejectedSuggestion.status).toBe(503);

    useIsolatedRuntime();
    const isolatedList = (await (
      await list(request("/v1/trust-rules?include_all=true"))
    ).json()) as { rules: Array<{ pattern: string }> };
    expect(
      isolatedList.rules.some((rule) => rule.pattern === "tenant-a-command"),
    ).toBe(true);
    expect(
      isolatedList.rules.some((rule) => rule.pattern === "tenant-b-command"),
    ).toBe(false);
  });

  test("pooled feature and privacy reads ignore prior assignment state", async () => {
    const defaults = loadFeatureFlagDefaults();
    const envOverrides = readEnvFeatureFlagOverrides();
    const candidate = Object.entries(defaults).find(
      ([key, value]) =>
        typeof value.defaultEnabled === "boolean" &&
        envOverrides[key] === undefined,
    );
    if (!candidate) throw new Error("Expected a boolean feature flag fixture.");
    const [flagKey, definition] = candidate;
    const defaultValue = definition.defaultEnabled as boolean;

    writeFeatureFlag(flagKey, !defaultValue);
    expect(getMergedFeatureFlags()[flagKey]).toBe(!defaultValue);

    const privacyPatch = createPrivacyConfigPatchHandler();
    const privacyGet = createPrivacyConfigGetHandler();
    expect(
      (
        await privacyPatch(
          request("/v1/config/privacy", "PATCH", {
            collectUsageData: true,
            sendDiagnostics: true,
            llmRequestLogRetentionMs: null,
          }),
        )
      ).status,
    ).toBe(200);

    usePooledRuntime();

    expect(getMergedFeatureFlags()[flagKey]).toBe(defaultValue);
    expect(
      (
        (await featureFlagIpcRoute("get_feature_flags").handler()) as Record<
          string,
          boolean | string
        >
      )[flagKey],
    ).toBe(defaultValue);
    expect(
      await featureFlagIpcRoute("get_feature_flag").handler({ flag: flagKey }),
    ).toBe(defaultValue);
    const featureResponse = await createFeatureFlagsGetHandler()(
      request("/v1/feature-flags"),
    );
    const featureBody = (await featureResponse.json()) as {
      flags: Array<{ key: string; enabled: boolean | string }>;
    };
    expect(
      featureBody.flags.find((flag) => flag.key === flagKey)?.enabled,
    ).toBe(defaultValue);
    expect(
      (
        await createFeatureFlagsPatchHandler()(
          request(`/v1/feature-flags/${flagKey}`, "PATCH", {
            enabled: defaultValue,
          }),
          flagKey,
        )
      ).status,
    ).toBe(503);

    expect(
      await (await privacyGet(request("/v1/config/privacy"))).json(),
    ).toEqual({
      collectUsageData: false,
      sendDiagnostics: false,
      llmRequestLogRetentionMs: 0,
    });
    expect(
      (
        await privacyPatch(
          request("/v1/config/privacy", "PATCH", {
            collectUsageData: false,
          }),
        )
      ).status,
    ).toBe(503);

    useIsolatedRuntime();
    expect(getMergedFeatureFlags()[flagKey]).toBe(!defaultValue);
    expect(
      await (await privacyGet(request("/v1/config/privacy"))).json(),
    ).toMatchObject({
      collectUsageData: true,
      sendDiagnostics: true,
      llmRequestLogRetentionMs: null,
    });
  });

  test("pooled local pairing, device, actor-token, and guardian endpoints fail closed", async () => {
    usePooledRuntime();

    const channelVerification = createChannelVerificationSessionProxyHandler(
      {} as GatewayConfig,
    );
    const guardianChannel = createGuardianChannelHandler();
    const attempts = [
      handlePair(request("/v1/pair", "POST"), "127.0.0.1"),
      handleListDevices(request("/v1/devices"), "127.0.0.1"),
      handleRevokeDevice(
        request("/v1/devices/revoke", "POST", {
          hashedDeviceId: "tenant-a-device",
        }),
        "127.0.0.1",
      ),
      handleCreateToken(request("/auth/token", "POST"), undefined),
      channelVerification.handleGuardianInit(
        request("/v1/guardian/init", "POST"),
        "127.0.0.1",
      ),
      channelVerification.handleGuardianRefresh(
        request("/v1/guardian/refresh", "POST", {
          refreshToken: "tenant-a-refresh-token",
          deviceId: "tenant-a-device",
        }),
      ),
      channelVerification.handleResetBootstrap(
        "127.0.0.1",
        request("/v1/guardian/reset-bootstrap", "POST"),
      ),
      guardianChannel(
        request("/v1/contacts/guardian/channel", "POST", {
          type: "email",
          address: "tenant-a@example.com",
          externalUserId: "tenant-a@example.com",
          status: "active",
        }),
      ),
      handleContactPromptSubmit(
        request("/v1/contacts/prompt/submit", "POST", {
          requestId: "tenant-a-request",
          address: "tenant-a@example.com",
          channelType: "email",
        }),
      ),
    ];

    for (const responsePromise of attempts) {
      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: POOLED_SHARED_STATE_ERROR_CODE,
      });
    }
  });

  test("pooled gateway-owned contact mutations fail closed while shared IPC reads are empty", async () => {
    usePooledRuntime();

    const contacts = createContactsControlPlaneProxyHandler(
      {} as GatewayConfig,
    );
    for (const responsePromise of [
      contacts.handleUpsertContact(
        request("/v1/contacts", "POST", {
          displayName: "Tenant A",
        }),
      ),
      contacts.handleDeleteContact("tenant-a-contact"),
      contacts.handleVerifyContactChannel(
        request("/v1/contact-channels/tenant-a-channel/verify", "POST"),
        "tenant-a-channel",
      ),
    ]) {
      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: POOLED_SHARED_STATE_ERROR_CODE,
      });
    }

    expect(await sharedStateIpcRoute("list_contacts").handler()).toEqual([]);
    expect(
      await sharedStateIpcRoute("get_contact").handler({
        contactId: "tenant-a-contact",
      }),
    ).toBeNull();
    expect(
      await sharedStateIpcRoute("get_contact_by_channel").handler({
        channelType: "email",
        externalUserId: "tenant-a@example.com",
      }),
    ).toBeNull();
    expect(
      await sharedStateIpcRoute("get_channels_for_contact").handler({
        contactId: "tenant-a-contact",
      }),
    ).toEqual([]);
    expect(() =>
      sharedStateIpcRoute("detach_slack_active_thread").handler({
        channelId: "tenant-a-channel",
        threadTs: "tenant-a-thread",
      }),
    ).toThrow(POOLED_SHARED_STATE_ERROR_CODE);
  });

  test("pooled A2A discovery cannot expose prior assignment identity", async () => {
    usePooledRuntime();
    const response = await createAgentCardHandler(new ConfigFileCache())(
      request("/.well-known/agent-card.json"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: POOLED_SHARED_STATE_ERROR_CODE,
    });
  });

  test("assistant-scoped process-global route guards remain before the catch-all", async () => {
    usePooledRuntime();
    const rejected = rejectPooledSharedStateAccess(
      "Assistant-scoped test state",
    );
    expect(rejected?.status).toBe(503);

    const indexSource = readFileSync(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );
    const contactRoute = indexSource.indexOf(
      "Assistant-scoped variant for clients using the auto-prefix.",
    );
    const readinessRoute = indexSource.indexOf(
      "assistants\\/([^/]+)\\/channels\\/readiness\\/?$",
    );
    const privacyRoute = indexSource.indexOf(
      "assistants\\/([^/]+)\\/config\\/privacy\\/?$",
    );
    const integrationStatusRoute = indexSource.indexOf(
      "assistants\\/([^/]+)\\/integrations\\/status\\/?$",
    );
    const catchAll = indexSource.indexOf("Runtime proxy catch-all");
    expect(contactRoute).toBeGreaterThan(-1);
    expect(readinessRoute).toBeGreaterThan(-1);
    expect(privacyRoute).toBeGreaterThan(-1);
    expect(integrationStatusRoute).toBeGreaterThan(-1);
    expect(indexSource.slice(contactRoute, contactRoute + 600)).toContain(
      "rejectPooledSharedStateAccess",
    );
    expect(indexSource.slice(readinessRoute, readinessRoute + 450)).toContain(
      "rejectPooledSharedStateAccess",
    );
    expect(contactRoute).toBeLessThan(catchAll);
    expect(readinessRoute).toBeLessThan(catchAll);
    expect(privacyRoute).toBeLessThan(catchAll);
    expect(integrationStatusRoute).toBeLessThan(catchAll);
    expect(indexSource).toContain("isPooledGatewayRuntime()\n          ? null");

    for (const marker of [
      "runPostAssistantReady()",
      "telegramDedupCache.startCleanup()",
      "await credentialWatcher.start()",
      "avatarSyncWatcher.start()",
      "configFileWatcher.start()",
      "featureFlagWatcher.start()",
      "void remoteFeatureFlagSync.start()",
      "sleepWakeDetector.start()",
    ]) {
      const markerIndex = indexSource.indexOf(marker);
      expect(markerIndex).toBeGreaterThan(-1);
      const guardIndex = indexSource.lastIndexOf(
        "if (sharedGatewayBackgroundServicesEnabled)",
        markerIndex,
      );
      expect(guardIndex).toBeGreaterThan(-1);
      expect(markerIndex - guardIndex).toBeLessThan(2_000);
    }
    const backupWorkerStart = indexSource.indexOf("startBackupWorker({");
    expect(backupWorkerStart).toBeGreaterThan(-1);
    expect(
      indexSource.slice(backupWorkerStart - 180, backupWorkerStart),
    ).toContain("sharedGatewayBackgroundServicesEnabled");

    const slackStart = indexSource.indexOf(
      "async function startSlackSocket(): Promise<void>",
    );
    expect(indexSource.slice(slackStart, slackStart + 260)).toContain(
      "assertPooledSharedStateUnavailable",
    );
    const twilioTunnelStart = indexSource.indexOf(
      "function maybeStartVelayTunnelForTwilio",
    );
    expect(
      indexSource.slice(twilioTunnelStart, twilioTunnelStart + 350),
    ).toContain("assertPooledSharedStateUnavailable");

    useIsolatedRuntime();
    expect(
      rejectPooledSharedStateAccess("Assistant-scoped test state"),
    ).toBeNull();
  });
});
