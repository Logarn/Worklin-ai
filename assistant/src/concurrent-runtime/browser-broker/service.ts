import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BROWSER_BROKER_INTERFACE_ID,
  BROWSER_BROKER_PROTOCOL_VERSION,
  type BrowserBrokerConnectRequest,
  type BrowserBrokerConnectResponse,
  type BrowserBrokerOperation,
  type BrowserBrokerReplayClass,
  type BrowserBrokerResultRequest,
} from "@vellumai/service-contracts/browser-broker";
import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";

import type { ConcurrentProviderConfigResolver } from "../../providers/platform-proxy/concurrent-request-context.js";
import { ConcurrentRuntimeStoreError } from "../store.js";
import type {
  BrowserActionAck,
  BrowserConnectionRecord,
  ConcurrentBrowserBrokerStore,
} from "./types.js";

const DEFAULT_CONNECTION_LEASE_MS = 45_000;
const DEFAULT_ACTION_DEADLINE_MS = 30_000;

export function hashBrowserConnectionToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function assertBrowserNavigationAllowed(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConcurrentRuntimeStoreError(
      "Browser navigation target is invalid.",
      "browser_access_denied",
    );
  }
  const rawHostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const mappedIpv4 = hostname.startsWith("::ffff:")
    ? hostname.slice("::ffff:".length)
    : "";
  const blockedHostname =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isPrivateIpv4(hostname) ||
    (mappedIpv4.length > 0 && isPrivateIpv4(mappedIpv4)) ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fe80:") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd");
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !hostname ||
    blockedHostname
  ) {
    throw new ConcurrentRuntimeStoreError(
      "Browser navigation target is blocked by policy.",
      "browser_access_denied",
    );
  }
}

function validateOperation(
  operation: BrowserBrokerOperation,
  allowedOrigins: ReadonlySet<string>,
): void {
  const validateUrl = (rawUrl: string) => {
    assertBrowserNavigationAllowed(rawUrl);
    if (!allowedOrigins.has(new URL(rawUrl).origin)) {
      throw new ConcurrentRuntimeStoreError(
        "Browser navigation origin is not in the deployment allowlist.",
        "browser_access_denied",
      );
    }
  };
  if (operation.kind === "navigate") {
    validateUrl(operation.url);
  }
  if (operation.kind === "open_session" && operation.initialUrl) {
    validateUrl(operation.initialUrl);
  }
}

export function replayClassForOperation(
  operation: BrowserBrokerOperation,
): BrowserBrokerReplayClass {
  return operation.kind === "status" ||
    operation.kind === "snapshot" ||
    operation.kind === "screenshot" ||
    operation.kind === "wait"
    ? "recomputable"
    : "non_replayable";
}

export interface BrowserBrokerServiceOptions {
  store: ConcurrentBrowserBrokerStore;
  connectionLeaseMs?: number;
  actionDeadlineMs?: number;
  now?: () => number;
  allowedOrigins?: readonly string[];
  onRunRunnable?: (
    context: TenantExecutionContext,
    runId: string,
    resolveProviderConfig?: ConcurrentProviderConfigResolver,
  ) => void | Promise<void>;
}

export class BrowserBrokerService {
  private readonly connectionLeaseMs: number;
  private readonly actionDeadlineMs: number;
  private readonly now: () => number;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(private readonly options: BrowserBrokerServiceOptions) {
    this.connectionLeaseMs =
      options.connectionLeaseMs ?? DEFAULT_CONNECTION_LEASE_MS;
    this.actionDeadlineMs =
      options.actionDeadlineMs ?? DEFAULT_ACTION_DEADLINE_MS;
    this.now = options.now ?? Date.now;
    this.allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((origin) => {
        assertBrowserNavigationAllowed(origin);
        const parsed = new URL(origin);
        if (parsed.origin !== origin || parsed.pathname !== "/") {
          throw new Error(
            "Concurrent browser allowed origins must be canonical HTTPS origins.",
          );
        }
        return parsed.origin;
      }),
    );
  }

  async connect(
    context: TenantExecutionContext,
    request: BrowserBrokerConnectRequest,
  ): Promise<BrowserBrokerConnectResponse> {
    const resumeToken = randomBytes(32).toString("base64url");
    const result = await this.options.store.connectBrowserClient(context, {
      clientInstallationId: request.clientInstallationId,
      capabilities: request.capabilities,
      leaseExpiresAt: this.now() + this.connectionLeaseMs,
      newConnectionId: randomUUID(),
      newResumeTokenHash: hashBrowserConnectionToken(resumeToken),
      ...(request.resume
        ? {
            resume: {
              connectionId: request.resume.connectionId,
              connectionGeneration: request.resume.connectionGeneration,
              resumeTokenHash: hashBrowserConnectionToken(
                request.resume.resumeToken,
              ),
            },
          }
        : {}),
    });
    return {
      protocolVersion: BROWSER_BROKER_PROTOCOL_VERSION,
      connectionId: result.connection.connectionId,
      connectionGeneration: result.connection.connectionGeneration,
      resumeToken,
      resumed: result.resumed,
      cursor: result.connection.cursor,
      leaseExpiresAt: new Date(result.connection.leaseExpiresAt).toISOString(),
    };
  }

  async heartbeat(
    context: TenantExecutionContext,
    input: {
      clientInstallationId: string;
      connectionId: string;
      connectionGeneration: number;
      connectionToken: string;
    },
  ): Promise<BrowserConnectionRecord> {
    const connection = await this.options.store.heartbeatBrowserConnection(
      context,
      {
        ...input,
        connectionTokenHash: hashBrowserConnectionToken(input.connectionToken),
        leaseExpiresAt: this.now() + this.connectionLeaseMs,
      },
    );
    if (!connection) {
      throw new ConcurrentRuntimeStoreError(
        "Browser connection is stale.",
        "stale_connection",
      );
    }
    return connection;
  }

  async dispatch(
    context: TenantExecutionContext,
    input: {
      conversationId: string;
      runId: string;
      toolUseId: string;
      operation: BrowserBrokerOperation;
      leaseOwner?: string;
      providerContent?: unknown;
      executionConfig?: Record<string, unknown>;
    },
  ) {
    validateOperation(input.operation, this.allowedOrigins);
    const operationHash = hashBrowserConnectionToken(
      stableJson(input.operation),
    );
    return this.options.store.enqueueBrowserAction(context, {
      ...input,
      actionId: randomUUID(),
      operationHash,
      replayClass: replayClassForOperation(input.operation),
      deadlineAt: this.now() + this.actionDeadlineMs,
    });
  }

  async recordResult(
    context: TenantExecutionContext,
    result: BrowserBrokerResultRequest,
    connectionToken: string,
    resolveProviderConfig?: ConcurrentProviderConfigResolver,
  ): Promise<BrowserActionAck> {
    const ack = await this.options.store.recordBrowserResult(
      context,
      result,
      hashBrowserConnectionToken(connectionToken),
    );
    if (ack.accepted && ack.runId && this.options.onRunRunnable) {
      await this.options.onRunRunnable(
        context,
        ack.runId,
        resolveProviderConfig,
      );
    }
    return ack;
  }
}

export const CONCURRENT_BROWSER_INTERFACE = {
  interfaceId: BROWSER_BROKER_INTERFACE_ID,
  protocolVersion: BROWSER_BROKER_PROTOCOL_VERSION,
} as const;
