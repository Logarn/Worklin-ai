/**
 * Queue drain and message processing logic extracted from Conversation.
 *
 * Conversation delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by conversation-history.ts.
 */

import {
  type BrandBrainContext,
  createDraftBrandBrain,
} from "@vellumai/retention-domain";

import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import {
  parseChannelId,
  parseInterfaceId,
  type TurnChannelContext,
  type TurnInterfaceContext,
} from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { saveBrandBrain } from "../memory/brand-brain-store.js";
import { listPendingRequestsByConversationScope } from "../memory/canonical-guardian-store.js";
import {
  addMessage,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
  updateConversationTitle,
} from "../memory/conversation-crud.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import { routeGuardianReply } from "../runtime/guardian-reply-router.js";
import {
  publishConversationMessagesChanged,
  publishConversationTitleChanged,
} from "../runtime/sync/resource-sync-events.js";
import {
  listUsableStoredKlaviyoConnections,
  type StoredKlaviyoConnection,
  validateAndStoreKlaviyoApiKey,
} from "../tools/retention/klaviyo-connection.js";
import { executeRetentionDeepAudit } from "../tools/retention/worklin-retention.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import type { CleanResult, Conversation } from "./conversation.js";
import type { AssistantSurface } from "./conversation-agent-loop.js";
import { buildPersistedAssistantContent } from "./conversation-agent-loop-handlers.js";
import {
  persistQueuedMessageBody,
  serializePersistedUserMessageContent,
} from "./conversation-messaging.js";
import type {
  QueuedMessage,
  QueueDrainReason,
} from "./conversation-queue-manager.js";
import {
  buildSlashContextForContent,
  classifySlash,
  resolveSlash,
  type SlashContext,
} from "./conversation-slash.js";
import { showStandaloneSurface } from "./conversation-surfaces.js";
import { getModelInfo } from "./handlers/config-model.js";
import { preactivateHostProxySkills } from "./host-proxy-preactivation.js";
import type {
  ServerMessage,
  UiSurfaceShow,
  UserMessageAttachment,
} from "./message-protocol.js";
import { isRetentionAuditSubagentNotification } from "./retention-audit-intent.js";
import { buildTransportHints } from "./transport-hints.js";
import { resolveTrustClass } from "./trust-context.js";
import { resolveVerificationSessionIntent } from "./verification-session-intent.js";

const log = getLogger("conversation-process");

function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "");
}

export function extractWebsiteUrl(content: string): string | undefined {
  const explicitMatch = content.match(/https?:\/\/[^\s<>"')]+/i);
  const rawMatch =
    explicitMatch?.[0] ??
    content.match(
      /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|co|io|ai|net|org|store|shop|health|clinic|care|beauty|skincare|us|uk|ca|au)(?:\/[^\s<>"')]+)?/i,
    )?.[0];
  if (!rawMatch) return undefined;
  const trimmed = trimTrailingUrlPunctuation(rawMatch);
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function fallbackBrandNameFromWebsiteUrl(websiteUrl: string | undefined) {
  if (!websiteUrl) return undefined;
  try {
    const host = new URL(websiteUrl).hostname.replace(/^www\./i, "");
    const stem = host.split(".")[0]?.replace(/[-_]+/g, " ");
    if (!stem) return undefined;
    return stem.replace(/\b\w/g, (char) => char.toUpperCase());
  } catch {
    return undefined;
  }
}

function extractRetentionBrandName(content: string): string | undefined {
  const brandMatch =
    content.match(
      /\b(?:onboard|setup|set up|for|brand|client|account)\s+(?:the\s+brand\s+|brand\s+|client\s+|account\s+)?([A-Z][A-Za-z0-9&'. -]{2,60}?)(?:\s+(?:as|using|with|in|on|from|before|website|site|account|klaviyo|shopify|audit)\b|[.,\n]|$)/,
    ) ??
    content.match(
      /\b(?:brand|client|account)\s*(?:name)?\s*(?:is|:)\s*([A-Z][A-Za-z0-9&'. -]{2,60})(?:[.,\n]|$)/,
    );
  return brandMatch?.[1]?.trim();
}

function textFromConversationMessage(
  message: Conversation["messages"][number],
): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function findRecentWebsiteUrl(
  conversation: Pick<Conversation, "messages">,
  content: string,
): string | undefined {
  const fromContent = extractWebsiteUrl(content);
  if (fromContent) return fromContent;
  for (const message of conversation.messages.slice(-12).reverse()) {
    const found = extractWebsiteUrl(textFromConversationMessage(message));
    if (found) return found;
  }
  return undefined;
}

function findRecentRetentionBrandName(
  conversation: Pick<Conversation, "messages">,
  content: string,
  websiteUrl: string | undefined,
): string {
  const fromContent = extractRetentionBrandName(content);
  if (fromContent) return fromContent;
  for (const message of conversation.messages.slice(-12).reverse()) {
    const text = textFromConversationMessage(message);
    const explicit = extractRetentionBrandName(text);
    if (explicit) return explicit;
    const profile = text.match(
      /\b(?:Website|Public site read):\s*([^\n]+)|\bfor\s+([A-Z][A-Za-z0-9&'. -]{2,80}?)(?:\s+with|\s+from|\s+using|[.\n]|$)/,
    );
    const candidate = (profile?.[1] ?? profile?.[2])?.trim();
    if (candidate && !/^https?:\/\//i.test(candidate)) return candidate;
  }
  return fallbackBrandNameFromWebsiteUrl(websiteUrl) ?? "this brand";
}

export function isRetentionOnboardingWebsiteReply(
  conversation: Pick<Conversation, "messages">,
  content: string,
): boolean {
  if (!extractWebsiteUrl(content)) return false;
  const recentAssistantText = conversation.messages
    .slice(-8)
    .filter((message) => message.role === "assistant")
    .map(textFromConversationMessage)
    .join("\n");
  return /what is the brand website|paste the url|paste the website/i.test(
    recentAssistantText,
  );
}

function buildDirectRetentionAuditInput(
  content: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    timeframe_days: 365,
    cadence: "first_run",
  };
  const websiteUrl = extractWebsiteUrl(content);
  if (websiteUrl) input.website_url = websiteUrl;
  const brandName = extractRetentionBrandName(content);
  if (brandName) input.brand_name = brandName;
  return input;
}

type PublicBrandSignal = {
  status: "fetched" | "unavailable" | "skipped";
  url?: string;
  title?: string;
  description?: string;
  productHints: string[];
  captureHints: string[];
  caveat?: string;
};

function compactText(value: string | undefined, fallback = "") {
  return (value ?? fallback).replace(/\s+/g, " ").trim();
}

function decodeBasicEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function uniqueLimited(values: string[], limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = decodeBasicEntities(compactText(value));
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

async function readPublicBrandSignal(
  websiteUrl: string | undefined,
): Promise<PublicBrandSignal> {
  if (!websiteUrl) {
    return {
      status: "skipped",
      productHints: [],
      captureHints: [],
      caveat: "No website/domain was supplied in the onboarding message.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(websiteUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "WorklinBrandBrain/0.1 (+read-only public onboarding)",
      },
    });
    if (!response.ok) {
      return {
        status: "unavailable",
        url: response.url || websiteUrl,
        productHints: [],
        captureHints: [],
        caveat: `Public homepage returned HTTP ${response.status}.`,
      };
    }

    const html = await response.text();
    const title = compactText(
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    );
    const description = compactText(
      html.match(
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      )?.[1] ??
        html.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
        )?.[1],
    );
    const linkLabels = Array.from(
      html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
    ).map((match) =>
      compactText(
        match[2]
          ?.replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " "),
      ),
    );
    const productHints = uniqueLimited(
      linkLabels.filter((label) =>
        /\b(product|shop|collection|bundle|kit|health|men|women|supplement|testosterone|prostate|blood|performance|weight|hormone)\b/i.test(
          label,
        ),
      ),
      8,
    );
    const captureHints = uniqueLimited(
      linkLabels.filter((label) =>
        /\b(quiz|subscribe|newsletter|sms|email|free|guide|consult|assessment|discount|offer)\b/i.test(
          label,
        ),
      ),
      6,
    );

    return {
      status: "fetched",
      url: response.url || websiteUrl,
      title: decodeBasicEntities(title),
      description: decodeBasicEntities(description),
      productHints,
      captureHints,
    };
  } catch (err) {
    const caveat = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      url: websiteUrl,
      productHints: [],
      captureHints: [],
      caveat,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readPublicBrandSignalWithDeadline(
  websiteUrl: string | undefined,
  deadlineMs = 5000,
): Promise<PublicBrandSignal> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PublicBrandSignal>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: websiteUrl ? "unavailable" : "skipped",
        url: websiteUrl,
        productHints: [],
        captureHints: [],
        caveat: `Public site read exceeded ${Math.round(deadlineMs / 1000)} seconds. I will continue onboarding with available context and can refresh this later.`,
      });
    }, deadlineMs);
  });

  try {
    return await Promise.race([readPublicBrandSignal(websiteUrl), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function lineList(values: string[], fallback: string) {
  if (values.length === 0) return `- ${fallback}`;
  return values.map((value) => `- ${value}`).join("\n");
}

function textFromRetentionOnboarding(
  brain: BrandBrainContext,
  signal: PublicBrandSignal,
  savedKlaviyo: StoredKlaviyoConnection[],
): string {
  const nextStepText =
    savedKlaviyo.length > 0
      ? [
          "## Next question",
          "",
          `Should I use the saved Klaviyo connection labeled "${savedKlaviyo[0]!.accountLabel}" for this brand?`,
          "",
          "Use the choices below. If the card does not appear, reply with what you want to do next.",
        ].join("\n")
      : [
          "## Next step",
          "",
          "Klaviyo is not connected yet, so I’ll open the read-only Klaviyo connection card next.",
          "",
          "You’ll only need the brand’s read-only Klaviyo private API key. Worklin will validate it with safe GET-only requests.",
        ].join("\n");
  const publicSourceLine =
    signal.status === "fetched"
      ? `Public site read: ${signal.title || signal.url || brain.websiteUrl || "homepage"}`
      : `Public site read: not completed yet (${signal.caveat ?? "source unavailable"}).`;
  const publicDescription =
    signal.description && signal.description.length > 0
      ? signal.description
      : brain.positioning.story;

  return [
    `Great — I found the website for ${brain.brandName}.`,
    "",
    "## First brand profile",
    "",
    "Here is the simple version:",
    `- Website: ${brain.websiteUrl ?? signal.url ?? "not provided"}`,
    `- ${publicSourceLine}`,
    `- What the brand seems to do: ${brain.positioning.uniqueSellingProposition}`,
    `- Short description: ${publicDescription}`,
    "",
    "What I can see so far:",
    lineList(
      signal.productHints.length > 0
        ? signal.productHints
        : brain.products
            .slice(0, 6)
            .map((product) => `${product.name} (${product.category})`),
      "I still need product details before I can name product-level opportunities.",
    ),
    "",
    "What I still need:",
    lineList(
      signal.captureHints,
      "I still need Klaviyo access to see campaigns, flows, signup forms, and email/SMS performance.",
    ),
    "",
    "Early notes:",
    lineList(
      [
        ...brain.audienceNotes.slice(0, 3),
        "I will not guess revenue, best sellers, or product winners until the right account data is connected.",
        "If Shopify is not connected yet, I can still start with a Klaviyo-only audit.",
      ],
      "I need one more answer before the brand profile is useful.",
    ),
    "",
    nextStepText,
    "",
    "After that, I’ll ask one simple question at a time.",
    "",
  ].join("\n");
}

function textFromRetentionOnboardingMissingWebsite(brandName: string): string {
  return [
    `Absolutely. I’ll help set up ${brandName === "this brand" ? "the brand" : brandName}.`,
    "",
    "I’ll ask one simple question at a time.",
    "",
    "## First question",
    "",
    "What is the brand website?",
    "",
    "Paste the URL, like yourbrand.com.",
  ].join("\n");
}

type RetentionOnboardingChoiceOption = {
  id: string;
  title: string;
  description?: string;
  recommended?: boolean;
  data?: Record<string, unknown>;
};

async function persistRetentionOnboardingMessage(
  conversation: Conversation,
  responseText: string,
  params: {
    requestId?: string;
    status: "started" | "brain_preview" | "choice_response" | "error";
    onEvent: (msg: ServerMessage) => void;
    surfaces?: AssistantSurface[];
  },
) {
  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: params.requestId,
      status: params.status,
    },
    "Retention onboarding persist start",
  );
  const assistantMsg = createAssistantMessage(responseText);
  const persistedContent =
    params.surfaces && params.surfaces.length > 0
      ? buildPersistedAssistantContent(assistantMsg.content, params.surfaces)
      : assistantMsg.content;
  const persistedAssistant = await addMessage(
    conversation.conversationId,
    "assistant",
    JSON.stringify(persistedContent),
    {
      metadata: {
        ...provenanceFromTrustContext(conversation.trustContext),
        sentAt: Date.now(),
        retentionOnboardingStatus: params.status,
      },
    },
  );
  conversation.messages.push(assistantMsg);
  params.onEvent({
    type: "assistant_text_delta",
    text: responseText,
    conversationId: conversation.conversationId,
    messageId: persistedAssistant.id,
    requestId: params.requestId,
  } as ServerMessage);
  params.onEvent({
    type: "message_complete",
    conversationId: conversation.conversationId,
    messageId: persistedAssistant.id,
  });
  publishConversationMessagesChanged(conversation.conversationId);
  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: params.requestId,
      status: params.status,
      messageId: persistedAssistant.id,
    },
    "Retention onboarding persist complete",
  );
}

function buildRetentionOnboardingChoiceSurface(params: {
  title: string;
  description: string;
  options: RetentionOnboardingChoiceOption[];
}): AssistantSurface {
  const surfaceId = `retention-onboarding-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return {
    surfaceId,
    surfaceType: "choice",
    title: params.title,
    data: {
      description: params.description,
      options: params.options,
      selectionMode: "single",
      commitOnSelect: true,
    },
    display: "inline",
  } as AssistantSurface;
}

function buildRetentionKlaviyoConnectionSurface(params: {
  brandName: string;
}): AssistantSurface {
  const surfaceId = `retention-klaviyo-connect-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return {
    surfaceId,
    surfaceType: "form",
    title: "Connect Klaviyo",
    data: {
      description: `Add the read-only Klaviyo private API key for ${params.brandName}. Worklin will validate it with GET-only Klaviyo requests and store it securely for recurring audits.`,
      fields: [
        {
          id: "account_label",
          type: "text",
          label: "Account label",
          placeholder: params.brandName,
          defaultValue: params.brandName,
          required: true,
        },
        {
          id: "api_key",
          type: "password",
          label: "Read-only Klaviyo API key",
          placeholder: "pk_...",
          required: true,
        },
      ],
      submitLabel: "Validate and save key",
    },
    display: "inline",
  } as AssistantSurface;
}

function submittedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseKlaviyoConnectionResult(content: string): {
  accountLabel?: string;
  snapshot?: {
    campaigns?: number;
    flows?: number;
    lists?: number;
    segments?: number;
    metrics?: number;
  } | null;
  error?: string;
} {
  try {
    const parsed = JSON.parse(content) as {
      account_label?: unknown;
      snapshot?: unknown;
      error?: unknown;
    };
    const snapshot =
      parsed.snapshot && typeof parsed.snapshot === "object"
        ? (parsed.snapshot as {
            campaigns?: number;
            flows?: number;
            lists?: number;
            segments?: number;
            metrics?: number;
          })
        : null;
    return {
      accountLabel:
        typeof parsed.account_label === "string"
          ? parsed.account_label
          : undefined,
      snapshot,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return {};
  }
}

async function showRetentionFirstAuditChoiceCard(
  conversation: Conversation,
  params: {
    brandName: string;
    websiteUrl?: string;
    requestId?: string;
    onEvent: (msg: ServerMessage) => void;
    introText: string;
  },
) {
  const auditSurface = buildRetentionOnboardingChoiceSurface({
    title: "Next step",
    description: "Do you want Worklin to run the first Klaviyo L365 audit now?",
    options: [
      {
        id: "run_first_audit",
        title: "Run the first audit",
        description: "Start the Klaviyo L365 audit now.",
        recommended: true,
      },
      {
        id: "not_yet",
        title: "Not yet",
        description: "Save the setup and pause here.",
      },
    ],
  });
  await persistRetentionOnboardingMessage(
    conversation,
    [
      params.introText,
      "",
      "Next question",
      "",
      "Do you want me to run the first audit now?",
    ].join("\n"),
    {
      requestId: params.requestId,
      status: "choice_response",
      onEvent: params.onEvent,
      surfaces: [auditSurface],
    },
  );
  showRetentionOnboardingChoices(conversation, {
    requestId: params.requestId,
    onEvent: params.onEvent,
    surface: auditSurface,
    responseByChoice: {
      not_yet:
        "Got it. Worklin can run the first audit whenever you are ready.",
    },
    onChoice: {
      run_first_audit: async () => {
        await runDirectRetentionAuditTurn(conversation, {
          content: [
            `Run the first Klaviyo L365 retention audit for ${params.brandName}.`,
            params.websiteUrl ? `Website: ${params.websiteUrl}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          requestId: params.requestId,
          userMessageId: "retention-onboarding-run-first-audit",
          onEvent: params.onEvent,
        });
      },
    },
  });
}

async function showRetentionKlaviyoConnectionCard(
  conversation: Conversation,
  params: {
    brandName: string;
    websiteUrl?: string;
    requestId?: string;
    onEvent: (msg: ServerMessage) => void;
  },
) {
  const surface = buildRetentionKlaviyoConnectionSurface({
    brandName: params.brandName,
  });
  await persistRetentionOnboardingMessage(
    conversation,
    [
      "Great. Add the read-only Klaviyo key in the card below.",
      "",
      "Worklin will validate it with read-only Klaviyo requests, then save it securely for this brand’s audits.",
      "",
      "Nothing will be sent, scheduled, activated, or changed in Klaviyo.",
    ].join("\n"),
    {
      requestId: params.requestId,
      status: "choice_response",
      onEvent: params.onEvent,
      surfaces: [surface],
    },
  );

  void showStandaloneSurface(
    conversation,
    {
      conversationId: conversation.conversationId,
      surfaceType: "form",
      title: surface.title,
      data: surface.data as Record<string, unknown>,
      timeoutMs: 15 * 60 * 1000,
    },
    surface.surfaceId,
  )
    .then(async (result) => {
      if (result.status !== "submitted") {
        await persistRetentionOnboardingMessage(
          conversation,
          "No problem. Klaviyo is not connected yet. When you are ready, choose “connect Klaviyo” again and I’ll reopen the secure card.",
          {
            requestId: params.requestId,
            status: "choice_response",
            onEvent: params.onEvent,
          },
        );
        return;
      }

      const apiKey = submittedString(result.submittedData?.api_key);
      const accountLabel =
        submittedString(result.submittedData?.account_label) ??
        params.brandName;

      if (!apiKey) {
        await persistRetentionOnboardingMessage(
          conversation,
          "I did not receive a Klaviyo key from the card, so nothing was saved. Choose “connect Klaviyo” again when you’re ready.",
          {
            requestId: params.requestId,
            status: "choice_response",
            onEvent: params.onEvent,
          },
        );
        return;
      }

      conversation.emitActivityState("tool_running", "tool_use_start", {
        requestId: params.requestId,
        statusText: "Validating the read-only Klaviyo key.",
      });

      const connectResult = await validateAndStoreKlaviyoApiKey({
        apiKey,
        accountLabel,
      });
      const parsed = parseKlaviyoConnectionResult(connectResult.content);

      if (connectResult.isError) {
        const retrySurface = buildRetentionOnboardingChoiceSurface({
          title: "Klaviyo connection",
          description:
            "Worklin could not validate that key. Do you want to try again?",
          options: [
            {
              id: "retry_klaviyo",
              title: "Try another key",
              description: "Open the read-only Klaviyo key card again.",
              recommended: true,
            },
            {
              id: "skip_connections",
              title: "Not now",
              description: "Keep setup moving without Klaviyo.",
            },
          ],
        });
        await persistRetentionOnboardingMessage(
          conversation,
          [
            "I could not connect Klaviyo with that key.",
            "",
            parsed.error
              ? `Reason: ${parsed.error}`
              : "Reason: Klaviyo validation failed.",
            "",
            "No key was saved.",
          ].join("\n"),
          {
            requestId: params.requestId,
            status: "choice_response",
            onEvent: params.onEvent,
            surfaces: [retrySurface],
          },
        );
        showRetentionOnboardingChoices(conversation, {
          requestId: params.requestId,
          onEvent: params.onEvent,
          surface: retrySurface,
          responseByChoice: {
            skip_connections:
              "No problem. We can continue with brand setup and connect Klaviyo later.",
          },
          onChoice: {
            retry_klaviyo: () =>
              showRetentionKlaviyoConnectionCard(conversation, params),
          },
        });
        return;
      }

      const snapshot = parsed.snapshot;
      await showRetentionFirstAuditChoiceCard(conversation, {
        ...params,
        introText: [
          `Klaviyo is connected for ${parsed.accountLabel ?? accountLabel}.`,
          "",
          snapshot
            ? `I can see ${snapshot.campaigns ?? 0} campaigns, ${snapshot.flows ?? 0} flows, ${snapshot.lists ?? 0} lists, ${snapshot.segments ?? 0} segments, and ${snapshot.metrics ?? 0} metrics from the read-only inventory check.`
            : "The key was validated and saved securely.",
        ].join("\n"),
      });
    })
    .catch((err) => {
      log.warn(
        {
          err,
          conversationId: conversation.conversationId,
          surfaceId: surface.surfaceId,
        },
        "Retention Klaviyo connection card failed",
      );
      params.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        requestId: params.requestId,
        message:
          err instanceof Error
            ? err.message
            : "Klaviyo connection card failed.",
      });
    });
}

export async function runRetentionKlaviyoConnectionTurn(
  conversation: Conversation,
  params: {
    content: string;
    requestId?: string;
    userMessageId: string;
    onEvent: (msg: ServerMessage) => void;
  },
): Promise<void> {
  const { content, requestId, onEvent } = params;
  const websiteUrl = findRecentWebsiteUrl(conversation, content);
  const brandName = findRecentRetentionBrandName(
    conversation,
    content,
    websiteUrl,
  );

  log.info(
    { conversationId: conversation.conversationId, requestId, brandName },
    "Retention Klaviyo connection intent intercepted",
  );

  conversation.setProcessing(true);
  conversation.currentTurnSurfaces = [];
  conversation.emitActivityState("tool_running", "tool_use_start", {
    requestId,
    statusText: "Opening the read-only Klaviyo connection card.",
  });

  try {
    await showRetentionKlaviyoConnectionCard(conversation, {
      brandName,
      websiteUrl,
      requestId,
      onEvent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, conversationId: conversation.conversationId, requestId },
      "Retention Klaviyo connection route failed",
    );
    await persistRetentionOnboardingMessage(
      conversation,
      [
        "I could not open the Klaviyo connection card.",
        "",
        `What failed: ${message}`,
        "",
        "No key was saved. Try the connection step again when you are ready.",
      ].join("\n"),
      {
        requestId,
        status: "error",
        onEvent,
      },
    );
  } finally {
    conversation.currentTurnSurfaces = [];
    conversation.setProcessing(false);
    await drainQueue(conversation);
  }
}

function showRetentionOnboardingChoices(
  conversation: Conversation,
  params: {
    requestId?: string;
    onEvent: (msg: ServerMessage) => void;
    surface: AssistantSurface;
    responseByChoice: Record<string, string>;
    onChoice?: Record<string, () => Promise<void>>;
  },
) {
  const surfaceId = params.surface.surfaceId;
  void showStandaloneSurface(
    conversation,
    {
      conversationId: conversation.conversationId,
      surfaceType: "choice",
      title: params.surface.title,
      data: params.surface.data as Record<string, unknown>,
      timeoutMs: 10 * 60 * 1000,
    },
    surfaceId,
  )
    .then(async (result) => {
      if (result.status !== "submitted" || !result.actionId) return;
      const handler = params.onChoice?.[result.actionId];
      if (handler) {
        await handler();
        return;
      }
      const responseText = params.responseByChoice[result.actionId];
      if (!responseText) return;
      await persistRetentionOnboardingMessage(conversation, responseText, {
        requestId: params.requestId,
        status: "choice_response",
        onEvent: params.onEvent,
      });
    })
    .catch((err) => {
      log.warn(
        { err, conversationId: conversation.conversationId, surfaceId },
        "Retention onboarding choice surface failed",
      );
    });
}

export async function runRetentionOnboardingTurn(
  conversation: Conversation,
  params: {
    content: string;
    requestId?: string;
    userMessageId: string;
    onEvent: (msg: ServerMessage) => void;
  },
): Promise<void> {
  const { content, requestId, onEvent } = params;
  log.info(
    { conversationId: conversation.conversationId, requestId },
    "Retention onboarding turn start",
  );
  conversation.setProcessing(true);
  conversation.currentTurnSurfaces = [];
  conversation.emitActivityState("thinking", "message_dequeued", {
    requestId,
    statusText: "Starting brand setup from the first onboarding answer.",
  });

  try {
    const websiteUrl = extractWebsiteUrl(content);
    const brandName =
      extractRetentionBrandName(content) ??
      fallbackBrandNameFromWebsiteUrl(websiteUrl) ??
      "this brand";
    if (!websiteUrl) {
      await persistRetentionOnboardingMessage(
        conversation,
        textFromRetentionOnboardingMissingWebsite(brandName),
        {
          requestId,
          status: "started",
          onEvent,
        },
      );
      return;
    }
    log.info(
      { conversationId: conversation.conversationId, requestId, brandName },
      "Retention onboarding kickoff resolved",
    );
    await persistRetentionOnboardingMessage(
      conversation,
      [
        `I’ll start onboarding ${brandName} with a short brand profile first.`,
        "",
        "I’m checking the website first so I can answer four basics:",
        "- what the brand sells",
        "- who it seems to sell to",
        "- what the offer or positioning looks like",
        "- what data I need next",
        "",
        "I’ll bring back a short brand profile next.",
        "",
        "---",
      ].join("\n"),
      {
        requestId,
        status: "started",
        onEvent,
      },
    );
    const signal = await readPublicBrandSignalWithDeadline(websiteUrl);
    const brain = createDraftBrandBrain({
      brandName,
      websiteUrl,
      storefront: {
        status: signal.status,
        url: signal.url,
        title: signal.title,
        description: signal.description,
        productHints: signal.productHints,
        caveat: signal.caveat,
      },
    });
    try {
      saveBrandBrain({
        brain,
        source: "onboarding",
        conversationId: conversation.conversationId,
        eventType: "onboarding_profile_created",
        eventPayload: {
          publicSignalStatus: signal.status,
          websiteUrl,
        },
      });
    } catch (err) {
      log.error(
        { err, conversationId: conversation.conversationId, requestId },
        "Failed to persist retention onboarding Brand Brain",
      );
    }
    log.info(
      {
        conversationId: conversation.conversationId,
        requestId,
        brandName: brain.brandName,
        publicSignalStatus: signal.status,
      },
      "Retention onboarding Brand Brain ready",
    );
    const savedKlaviyo = await listUsableStoredKlaviyoConnections();
    const responseText = textFromRetentionOnboarding(
      brain,
      signal,
      savedKlaviyo,
    );
    const title = `${brain.brandName} Brand Profile`;
    updateConversationTitle(conversation.conversationId, title, 0);
    publishConversationTitleChanged(conversation.conversationId, title);
    if (savedKlaviyo.length === 0) {
      await persistRetentionOnboardingMessage(conversation, responseText, {
        requestId,
        status: "brain_preview",
        onEvent,
      });
      await showRetentionKlaviyoConnectionCard(conversation, {
        brandName: brain.brandName,
        websiteUrl,
        requestId,
        onEvent,
      });
      return;
    }

    const nextStepSurface = buildRetentionOnboardingChoiceSurface({
      title: "Second question",
      description: `Use the saved Klaviyo connection labeled "${savedKlaviyo[0]!.accountLabel}"?`,
      options: [
        {
          id: "use_saved_klaviyo",
          title: `Use "${savedKlaviyo[0]!.accountLabel}"`,
          description: "Use this saved read-only account.",
          recommended: true,
        },
        {
          id: "add_different_klaviyo",
          title: "Use a different Klaviyo key",
          description: "Open the read-only Klaviyo key card.",
        },
        {
          id: "skip_connections",
          title: "Not yet",
          description: "Keep setup moving without Klaviyo.",
        },
      ],
    });

    await persistRetentionOnboardingMessage(conversation, responseText, {
      requestId,
      status: "brain_preview",
      onEvent,
      surfaces: [nextStepSurface],
    });
    showRetentionOnboardingChoices(conversation, {
      requestId,
      onEvent,
      surface: nextStepSurface,
      responseByChoice: {
        skip_connections:
          "No problem. Next question: what does the brand sell? One sentence is enough.",
      },
      onChoice: {
        use_saved_klaviyo: () =>
          showRetentionFirstAuditChoiceCard(conversation, {
            brandName: brain.brandName,
            websiteUrl,
            requestId,
            onEvent,
            introText: `Great. I’ll use "${savedKlaviyo[0]?.accountLabel ?? "the saved read-only Klaviyo connection"}" for this brand’s first audit.`,
          }),
        add_different_klaviyo: () =>
          showRetentionKlaviyoConnectionCard(conversation, {
            brandName: brain.brandName,
            websiteUrl,
            requestId,
            onEvent,
          }),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, conversationId: conversation.conversationId, requestId },
      "Retention onboarding route failed",
    );
    try {
      await persistRetentionOnboardingMessage(
        conversation,
        [
          "I hit a snag while building the brand profile.",
          "",
          `What failed: ${message}`,
          "",
          "You can retry onboarding, or connect Klaviyo when you are ready and I will continue from there.",
        ].join("\n"),
        {
          requestId,
          status: "error",
          onEvent,
        },
      );
    } catch (persistErr) {
      log.error(
        {
          err: persistErr,
          conversationId: conversation.conversationId,
          requestId,
        },
        "Retention onboarding error fallback could not be persisted",
      );
    }
    onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      requestId,
      message,
    });
  } finally {
    conversation.currentTurnSurfaces = [];
    conversation.setProcessing(false);
    await drainQueue(conversation);
  }
}

function textFromRetentionAuditResult(result: ToolExecutionResult): string {
  if (result.isError) {
    return result.content || "Worklin could not complete the retention audit.";
  }
  try {
    const parsed = JSON.parse(result.content) as {
      auditId?: unknown;
      artifact?: { contentMarkdown?: unknown };
      title?: unknown;
      brandName?: unknown;
      status?: unknown;
      reason?: unknown;
      summary?: {
        moduleCount?: unknown;
        chartCount?: unknown;
        backlogCount?: unknown;
        sourceMode?: unknown;
        fullCommerceAuditBlocked?: unknown;
      };
      topOpportunities?: Array<{
        title?: unknown;
        impact?: unknown;
        confidence?: unknown;
        nextAction?: unknown;
      }>;
      nextActions?: unknown[];
      document?: { instruction?: unknown };
      safety?: {
        externalActionTaken?: unknown;
        canGoLiveNow?: unknown;
        blockedCapabilities?: unknown;
      };
    };
    if (typeof parsed.artifact?.contentMarkdown === "string") {
      const lines = [parsed.artifact.contentMarkdown];
      if (typeof parsed.document?.instruction === "string") {
        lines.push("", `PDF export: ${parsed.document.instruction}`);
      }
      return lines.join("\n");
    }
    if (typeof parsed.auditId === "string") {
      const title =
        typeof parsed.title === "string" ? parsed.title : "Retention Audit";
      const brand =
        typeof parsed.brandName === "string" && parsed.brandName.trim()
          ? parsed.brandName.trim()
          : "this account";
      const moduleCount =
        typeof parsed.summary?.moduleCount === "number"
          ? parsed.summary.moduleCount
          : undefined;
      const chartCount =
        typeof parsed.summary?.chartCount === "number"
          ? parsed.summary.chartCount
          : undefined;
      const backlogCount =
        typeof parsed.summary?.backlogCount === "number"
          ? parsed.summary.backlogCount
          : undefined;
      const sourceMode =
        typeof parsed.summary?.sourceMode === "string"
          ? parsed.summary.sourceMode
          : undefined;
      const commerceBlocked = parsed.summary?.fullCommerceAuditBlocked === true;
      const topOpportunity = parsed.topOpportunities?.find(
        (item) => typeof item?.title === "string",
      );
      const nextAction =
        typeof topOpportunity?.nextAction === "string"
          ? topOpportunity.nextAction
          : parsed.nextActions?.find(
              (item): item is string => typeof item === "string",
            );
      const externalActionTaken =
        parsed.safety?.externalActionTaken === true ? "true" : "false";
      const canGoLiveNow =
        parsed.safety?.canGoLiveNow === true ? "true" : "false";

      const lines = [
        `Done — I generated the ${title} for ${brand}.`,
        "",
        [
          moduleCount != null ? `${moduleCount} audit modules` : null,
          chartCount != null ? `${chartCount} interactive charts` : null,
          backlogCount != null
            ? `${backlogCount} prioritized opportunities`
            : null,
          sourceMode ? `source mode: ${sourceMode}` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(" / "),
        "",
        "Use the audit card below to explore the charts, open the editable document, or download the PDF.",
      ];

      if (typeof topOpportunity?.title === "string") {
        lines.push(
          "",
          `Top opportunity: ${topOpportunity.title}`,
          ...(typeof nextAction === "string"
            ? [`Next action: ${nextAction}`]
            : []),
        );
      } else if (typeof nextAction === "string") {
        lines.push("", `Next action: ${nextAction}`);
      }

      if (commerceBlocked) {
        lines.push(
          "",
          "Note: this is a Klaviyo-first audit. Shopify is optional enrichment for product, order, LTV, AOV, and revenue reconciliation.",
        );
      }

      lines.push(
        "",
        `Safety: externalActionTaken:${externalActionTaken}, canGoLiveNow:${canGoLiveNow}. No sends, schedules, flow activations, profile mutations, segment mutations, or Shopify writes were performed.`,
      );

      return lines
        .filter((line, index, arr) => {
          if (line !== "") return true;
          return arr[index - 1] !== "";
        })
        .join("\n");
    }
    if (typeof parsed.reason === "string") {
      return [
        parsed.title ?? "Retention audit blocked",
        "",
        parsed.reason,
        "",
        "Safety & provenance",
        "- externalActionTaken:false",
        "- canGoLiveNow:false",
      ].join("\n");
    }
  } catch {
    // Fall through to raw content.
  }
  return result.content || "Worklin completed the retention audit.";
}

function titleFromRetentionAuditResult(
  result: ToolExecutionResult,
): string | null {
  if (result.isError) return null;
  try {
    const parsed = JSON.parse(result.content) as {
      auditId?: unknown;
      title?: unknown;
      brandName?: unknown;
    };
    if (typeof parsed.auditId !== "string") return null;

    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : "Retention Audit";
    const brand =
      typeof parsed.brandName === "string" && parsed.brandName.trim()
        ? parsed.brandName.trim()
        : "";
    const fullTitle = brand ? `${brand} - ${title}` : title;
    const normalized = fullTitle.replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    return normalized.length > 90
      ? `${normalized.slice(0, 87).trimEnd()}...`
      : normalized;
  } catch {
    return null;
  }
}

export async function runDirectRetentionAuditTurn(
  conversation: Conversation,
  params: {
    content: string;
    requestId?: string;
    userMessageId: string;
    onEvent: (msg: ServerMessage) => void;
  },
): Promise<void> {
  const { content, requestId, onEvent } = params;
  conversation.setProcessing(true);
  conversation.currentTurnSurfaces = [];
  conversation.emitActivityState("thinking", "message_dequeued", {
    requestId,
    statusText:
      "Running Worklin's read-only retention audit. Real Klaviyo audits can take 15-45 minutes; keep this tab open in the local test build.",
  });

  const toolContext: ToolContext = {
    conversationId: conversation.conversationId,
    workingDir: conversation.workingDir,
    requestId,
    assistantId: conversation.assistantId,
    trustClass: resolveTrustClass(conversation.trustContext),
    executionChannel: conversation.trustContext?.sourceChannel,
    sourceActorPrincipalId: conversation.trustContext?.guardianPrincipalId,
    requesterExternalUserId: conversation.trustContext?.requesterExternalUserId,
    requesterChatId: conversation.trustContext?.requesterChatId,
    requesterIdentifier: conversation.trustContext?.requesterIdentifier,
    requesterDisplayName: conversation.trustContext?.requesterDisplayName,
    signal: conversation.abortController?.signal,
    isInteractive: !conversation.hasNoClient && !conversation.headlessLock,
    transportInterface: conversation.transportInterface,
    overrideProfile: conversation.currentTurnOverrideProfile,
    sendToClient: (msg) => {
      conversation.sendToClient(msg as ServerMessage);
      if (msg.type === "ui_surface_show") {
        const surface = msg as unknown as UiSurfaceShow;
        conversation.currentTurnSurfaces.push({
          surfaceId: surface.surfaceId,
          surfaceType: surface.surfaceType,
          title: surface.title,
          data: surface.data,
          actions: surface.actions,
          display: surface.display,
          ...(surface.persistent ? { persistent: true } : {}),
          ...(surface.toolCallId ? { toolCallId: surface.toolCallId } : {}),
        });
      }
    },
  };

  try {
    const startedText = [
      "Starting the read-only Worklin audit now.",
      "",
      "I’ll review the connected Klaviyo account across the last 365 days, including campaigns, flows, signup forms, lists and segments, deliverability signals, lifecycle coverage, and opportunity gaps.",
      "",
      "Real account audits can take 15-45 minutes depending on account size. Keep this Worklin tab open in the local test build; I’ll post the client-ready audit card here when it finishes.",
      "",
      "Safety: no sends, schedules, flow activations, profile mutations, segment mutations, or Shopify writes will be performed.",
    ].join("\n");
    const startedMsg = createAssistantMessage(startedText);
    await addMessage(
      conversation.conversationId,
      "assistant",
      JSON.stringify(startedMsg.content),
      {
        metadata: {
          ...provenanceFromTrustContext(conversation.trustContext),
          sentAt: Date.now(),
          retentionAuditStatus: "started",
        },
      },
    );
    conversation.messages.push(startedMsg);
    publishConversationMessagesChanged(conversation.conversationId);

    const result = await executeRetentionDeepAudit(
      buildDirectRetentionAuditInput(content),
      toolContext,
    );
    const auditTitle = titleFromRetentionAuditResult(result);
    if (auditTitle) {
      updateConversationTitle(conversation.conversationId, auditTitle, 0);
      publishConversationTitleChanged(conversation.conversationId, auditTitle);
    }
    const responseText = textFromRetentionAuditResult(result);
    const assistantMsg = createAssistantMessage(responseText);
    const contentWithSurfaces = buildPersistedAssistantContent(
      assistantMsg.content,
      conversation.currentTurnSurfaces,
    );

    const persistedAssistant = await addMessage(
      conversation.conversationId,
      "assistant",
      JSON.stringify(contentWithSurfaces),
      {
        metadata: {
          ...provenanceFromTrustContext(conversation.trustContext),
          sentAt: Date.now(),
        },
      },
    );
    conversation.messages.push({
      ...assistantMsg,
      content: contentWithSurfaces,
    });
    onEvent({
      type: "assistant_text_delta",
      text: responseText,
      conversationId: conversation.conversationId,
      messageId: persistedAssistant.id,
      requestId,
    } as ServerMessage);
    conversation.traceEmitter.emit(
      "message_complete",
      result.isError
        ? "Direct retention audit failed"
        : "Direct retention audit completed",
      {
        requestId,
        status: result.isError ? "error" : "success",
      },
    );
    onEvent({
      type: "message_complete",
      conversationId: conversation.conversationId,
      messageId: persistedAssistant.id,
    });
    publishConversationMessagesChanged(conversation.conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, conversationId: conversation.conversationId, requestId },
      "Direct retention audit route failed",
    );
    onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      requestId,
      message,
    });
  } finally {
    conversation.currentTurnSurfaces = [];
    conversation.setProcessing(false);
    await drainQueue(conversation);
  }
}

/** Format the result of a forced compaction into a user-facing message. */
export function formatCompactResult(result: ContextWindowResult): string {
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
  if (!result.compacted) {
    return [
      `Context compaction skipped — ${result.reason ?? "nothing to compact"}.`,
      `Context: ${fmt(result.estimatedInputTokens)} / ${fmt(
        result.maxInputTokens,
      )} tokens`,
    ].join("\n");
  }
  const saved =
    result.previousEstimatedInputTokens - result.estimatedInputTokens;
  return [
    "Context Compacted\n",
    `Tokens:   ${fmt(result.previousEstimatedInputTokens)} → ${fmt(result.estimatedInputTokens)} (${fmt(saved)} saved)`,
    `Context:  ${fmt(result.estimatedInputTokens)} / ${fmt(
      result.maxInputTokens,
    )} tokens`,
    `Messages: ${fmt(result.compactedMessages)} compacted`,
    `Tail:     ${fmt(result.preservedTailMessages)} preserved`,
  ].join("\n");
}

/** Format the result of a forced clean into a user-facing message. */
export function formatCleanResult(result: CleanResult): string {
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
  const reclaimed =
    result.previousEstimatedInputTokens - result.estimatedInputTokens;
  return [
    "Context Cleaned\n",
    `Tokens:   ${fmt(result.previousEstimatedInputTokens)} → ${fmt(result.estimatedInputTokens)} (${fmt(reclaimed)} reclaimed)`,
    `Context:  ${fmt(result.estimatedInputTokens)} / ${fmt(
      result.maxInputTokens,
    )} tokens`,
    `Messages: ${fmt(result.preservedMessages)} preserved`,
  ].join("\n");
}

/** Build a model_info event with fresh config data. */
export async function buildModelInfoEvent(
  conversationId?: string,
): Promise<ServerMessage> {
  return { type: "model_info", conversationId, ...(await getModelInfo()) };
}

/** True when the trimmed content is the /models slash command. */
export function isModelSlashCommand(content: string): boolean {
  return content.trim() === "/models";
}

function resolveQueuedTurnContext(
  queued: {
    turnChannelContext?: TurnChannelContext;
    metadata?: Record<string, unknown>;
  },
  fallback: TurnChannelContext | null,
): TurnChannelContext | null {
  if (queued.turnChannelContext) return queued.turnChannelContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageChannel = parseChannelId(metadata.userMessageChannel);
    const assistantMessageChannel = parseChannelId(
      metadata.assistantMessageChannel,
    );
    if (userMessageChannel && assistantMessageChannel) {
      return { userMessageChannel, assistantMessageChannel };
    }
  }
  return fallback;
}

function resolveQueuedTurnInterfaceContext(
  queued: {
    turnInterfaceContext?: TurnInterfaceContext;
    metadata?: Record<string, unknown>;
  },
  fallback: TurnInterfaceContext | null,
): TurnInterfaceContext | null {
  if (queued.turnInterfaceContext) return queued.turnInterfaceContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageInterface = parseInterfaceId(
      metadata.userMessageInterface,
    );
    const assistantMessageInterface = parseInterfaceId(
      metadata.assistantMessageInterface,
    );
    if (userMessageInterface && assistantMessageInterface) {
      return { userMessageInterface, assistantMessageInterface };
    }
  }
  return fallback;
}

/** Build a SlashContext from the current conversation state and config. */
function buildSlashContext(
  content: string,
  conversation: Conversation,
): SlashContext | undefined {
  const turnInterface = conversation.getTurnInterfaceContext();
  return buildSlashContextForContent(content, {
    conversationId: conversation.conversationId,
    messageCount: conversation.messages.length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    estimatedCost: conversation.usageStats.estimatedCost,
    userMessageInterface: turnInterface?.userMessageInterface,
  });
}

/**
 * Walk the head of the queue and return the longest contiguous run of
 * passthrough messages (non-slash, non-verification-intent) that share the
 * same `userMessageInterface`. Returns `[]` when the head is itself a slash
 * command or verification-intent direct-setup — in that case `drainQueue`
 * pops the head via `queue.shift()` and the single-message path handles it.
 *
 * The builder uses `peek` for lookahead and only calls `shiftN(matched)` once
 * a contiguous passthrough run is identified. This keeps byte-budget
 * accounting centralized in `MessageQueue` rather than mutating mid-walk.
 */
async function buildPassthroughBatch(
  conversation: Conversation,
): Promise<QueuedMessage[]> {
  const head = conversation.queue.peek(0);
  if (head === undefined) return [];

  const headInterface = resolveQueuedTurnInterfaceContext(
    head,
    conversation.getTurnInterfaceContext(),
  );
  // Pure classifier — no side effects. `resolveSlash` may run side effects
  // (e.g. /compact); if we called it here the real drain would invoke those
  // again.
  if (classifySlash(head.content) !== "passthrough") return [];
  if (resolveVerificationSessionIntent(head.content).kind === "direct_setup") {
    // Verification intents stay on the single-message path so their per-turn
    // skill preactivation isn't leaked into batched tail messages.
    return [];
  }
  if (isRetentionAuditSubagentNotification(head.content)) return [];
  // Surface-action messages rely on per-message `activeSurfaceId` and
  // `surfaceActionRequestIds` semantics that last-wins batching would
  // corrupt (e.g. erasing the head's surface context when the last tail is
  // a regular text message). Keep them on the single-message path.
  if (
    head.activeSurfaceId !== undefined ||
    conversation.surfaceActionRequestIds.has(head.requestId)
  ) {
    return [];
  }

  let i = 1;
  for (;;) {
    const candidate = conversation.queue.peek(i);
    if (candidate === undefined) break;
    const candIf = resolveQueuedTurnInterfaceContext(
      candidate,
      conversation.getTurnInterfaceContext(),
    );
    // Treat an undefined interface as distinct from a defined one so we don't
    // silently batch cross-interface messages whose env/transport would
    // otherwise diverge.
    if (candIf?.userMessageInterface !== headInterface?.userMessageInterface)
      break;
    if (candidate.sourceActorPrincipalId !== head.sourceActorPrincipalId) break;
    if (classifySlash(candidate.content) !== "passthrough") break;
    if (
      resolveVerificationSessionIntent(candidate.content).kind ===
      "direct_setup"
    )
      break;
    if (isRetentionAuditSubagentNotification(candidate.content)) break;
    // Stop at the first surface-action tail; it will drain via the single-
    // message path so its per-message surface context is preserved.
    if (
      candidate.activeSurfaceId !== undefined ||
      conversation.surfaceActionRequestIds.has(candidate.requestId)
    ) {
      break;
    }
    i++;
  }

  const matched = i;
  return conversation.queue.shiftN(matched);
}

// ── Steer repair ────────────────────────────────────────────────────

/**
 * When a steer-to-message abort interrupts an in-flight tool call, the
 * conversation history may end with an assistant message containing one
 * or more `tool_use` blocks that have no corresponding `tool_result`.
 * LLM providers reject this sequence. This helper scans the tail of the
 * history and injects synthetic error `tool_result` messages for any
 * unmatched `tool_use` blocks.
 */
function repairPendingToolUseBlocks(conversation: Conversation): void {
  if (!conversation.pendingSteerRepair) return;
  conversation.pendingSteerRepair = false;

  const messages = conversation.messages;
  if (messages.length === 0) return;

  // Walk backwards from the tail to find the last assistant message with
  // tool_use blocks. Collect resolved IDs from any user messages between
  // the tail and that assistant message, then subtract them.
  const resolvedToolUseIds = new Set<string>();
  const pendingToolUseIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (
          block.type === "tool_result" ||
          block.type === "web_search_tool_result"
        ) {
          resolvedToolUseIds.add(block.tool_use_id);
        }
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use" && !resolvedToolUseIds.has(block.id)) {
          pendingToolUseIds.push(block.id);
        }
      }
      // Only repair tool_use blocks from the last assistant message that
      // has them — earlier history should already be consistent.
      break;
    }
  }

  if (pendingToolUseIds.length === 0) return;

  log.info(
    {
      conversationId: conversation.conversationId,
      pendingToolUseCount: pendingToolUseIds.length,
    },
    "Injecting synthetic tool_result for pending tool_use blocks after steer",
  );

  // Build a single user message with tool_result blocks for all pending IDs.
  const syntheticContent = pendingToolUseIds.map((toolUseId) => ({
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content: "Tool execution was interrupted by user steering.",
    is_error: true,
  }));
  conversation.messages.push({
    role: "user",
    content: syntheticContent,
  });
}

// ── drainQueue ───────────────────────────────────────────────────────

/**
 * Process the next message in the queue, if any.
 * Called from the `runAgentLoop` finally block after processing completes.
 *
 * When a dequeued message fails to persist (e.g. empty content, DB error),
 * `processMessage` catches the error and resolves without calling
 * `runAgentLoop`. Since the drain chain depends on `runAgentLoop`'s `finally`
 * block, we must explicitly continue draining on failure — otherwise
 * remaining queued messages would be stranded.
 */
export async function drainQueue(
  conversation: Conversation,
  reason: QueueDrainReason = "loop_complete",
): Promise<void> {
  // After a steer, drain only the promoted head message — don't batch
  // the remaining queue items into the same turn.
  const steered = conversation.pendingSteerRepair;

  // Repair any pending tool_use blocks left over from a steered abort
  // before the drain path sends the next message to the LLM.
  repairPendingToolUseBlocks(conversation);

  if (steered) {
    const next = conversation.queue.shift();
    if (!next) return;
    return drainSingleMessage(conversation, next, reason);
  }

  const batch = await buildPassthroughBatch(conversation);
  if (batch.length === 0) {
    // Head is a slash / verification intent / empty queue. If the queue has
    // an item the builder rejected, pop it and hand it to the single-message
    // path — which owns slash / compact / verification-intent behavior.
    const next = conversation.queue.shift();
    if (!next) return;
    return drainSingleMessage(conversation, next, reason);
  }
  if (batch.length === 1) {
    return drainSingleMessage(conversation, batch[0], reason);
  }
  return drainBatch(conversation, batch, reason);
}

async function drainSingleMessage(
  conversation: Conversation,
  next: QueuedMessage,
  reason: QueueDrainReason,
): Promise<void> {
  // Reset per-turn preactivation so a prior iteration (e.g. an unknown-slash
  // from a desktop source that skips runAgentLoop) can't leak CU preactivation
  // into the next queued message.
  conversation.preactivatedSkillIds = undefined;
  // Onboarding skill cues are intentionally one-shot. Re-add them after the
  // reset for the first message so the initial LLM turn can project their
  // tools, while later turns return to normal conversation-driven activation.
  if (conversation.messages.length === 0) {
    // Older host-proxy conversation doubles may not carry onboarding context.
    // Treat that as an empty context rather than breaking their first turn.
    const onboardingSkills = conversation.getOnboardingContext?.()?.skills;
    if (onboardingSkills?.length) {
      conversation.setPreactivatedSkillIds([...new Set(onboardingSkills)]);
    }
  }

  if (isRetentionAuditSubagentNotification(next.content)) {
    log.info(
      {
        conversationId: conversation.conversationId,
        requestId: next.requestId,
        reason,
      },
      "Skipping internal retention audit subagent notification",
    );
    conversation.traceEmitter.emit(
      "message_complete",
      "Internal retention audit subagent notification skipped",
      {
        requestId: next.requestId,
        status: "success",
      },
    );
    next.onEvent({
      type: "message_complete",
      conversationId: conversation.conversationId,
    });
    publishConversationMessagesChanged(conversation.conversationId);
    await drainQueue(conversation, reason);
    return;
  }

  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: next.requestId,
      reason,
    },
    "Dequeuing message",
  );
  conversation.traceEmitter.emit(
    "request_dequeued",
    `Message dequeued (${reason})`,
    {
      requestId: next.requestId,
      status: "info",
      attributes: { reason },
    },
  );
  next.onEvent({
    type: "message_dequeued",
    conversationId: conversation.conversationId,
    requestId: next.requestId,
  });
  conversation.emitActivityState("thinking", "message_dequeued", {
    requestId: next.requestId,
  });

  const queuedTurnCtx = resolveQueuedTurnContext(
    next,
    conversation.getTurnChannelContext(),
  );
  if (queuedTurnCtx) {
    conversation.setTurnChannelContext(queuedTurnCtx);
  }

  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    next,
    conversation.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) {
    conversation.setTurnInterfaceContext(queuedInterfaceCtx);
  }

  // Apply transport hints from the queued message so each turn uses the
  // transport metadata that arrived with its message. Messages without
  // transport (subagent notifications, surface actions, etc.) inherit the
  // conversation's existing hints — clearing them would erase the user's
  // environment context for internal turns.
  if (next.transport) {
    conversation.setTransportHints(buildTransportHints(next.transport));
    // Route client-reported host env through the same capability-gated
    // setter used by DaemonServer.applyTransportMetadata so create/reuse
    // and queue-drain stay in sync without duplicating the gate logic.
    conversation.applyHostEnvFromTransport(next.transport);
    conversation.applyClientTimezoneFromTransport(next.transport);
  }

  conversation.currentTurnAuthContext = next.authContext;
  conversation.currentTurnSourceActorPrincipalId = next.sourceActorPrincipalId;

  // Re-attach and re-preactivate host-proxy skills for interactive turns.
  // The dequeue path reset `preactivatedSkillIds` above; without these
  // re-adds the relevant skill tools won't be projected to the LLM for
  // queued messages 2+. Also instantiates proxies that may not have been
  // present when the message was first enqueued (e.g. a macOS client
  // connects between enqueue and drain). Mirrors the per-message block in
  // `conversation-routes.ts` / `process-message.ts`.
  if (next.isInteractive !== false) {
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    const sourceActorPrincipalId = next.sourceActorPrincipalId;
    conversation.ensureHostProxiesForTurn(
      sourceInterface,
      sourceActorPrincipalId,
    );
    preactivateHostProxySkills(
      conversation,
      sourceInterface,
      sourceActorPrincipalId,
    );
  }

  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;

  // Resolve slash commands for queued messages
  const slashResult = await resolveSlash(
    next.content,
    buildSlashContext(next.content, conversation),
  );

  // Unknown slash — persist the exchange and continue draining.
  // Persist each message before pushing to conversation.messages so that a
  // failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    try {
      const drainProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const drainImageSourcePaths: Record<string, string> = {};
      for (let i = 0; i < next.attachments.length; i++) {
        const a = next.attachments[i];
        if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
          drainImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
        }
      }
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? {
              userMessageChannel: queuedTurnCtx.userMessageChannel,
              assistantMessageChannel: queuedTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(queuedInterfaceCtx
          ? {
              userMessageInterface: queuedInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                queuedInterfaceCtx.assistantMessageInterface,
            }
          : {}),
        ...(next.metadata?.automated ? { automated: true } : {}),
        ...(Object.keys(drainImageSourcePaths).length > 0
          ? { imageSourcePaths: drainImageSourcePaths }
          : {}),
        sentAt: next.sentAt,
      };
      const cleanUserMsg = createUserMessage(next.content, next.attachments);
      const llmUserMsg = enrichMessageWithSourcePaths(
        cleanUserMsg,
        next.attachments,
      );
      // When displayContent is provided (e.g. original text before recording
      // intent stripping), persist that to DB so users see the full message.
      // The in-memory userMessage (sent to the LLM) still uses the stripped content.
      const contentToPersist = serializePersistedUserMessageContent(
        next.content,
        next.attachments,
        next.displayContent,
      );
      await addMessage(conversation.conversationId, "user", contentToPersist, {
        metadata: drainChannelMeta,
      });
      conversation.messages.push(llmUserMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: { ...drainChannelMeta, sentAt: Date.now() } },
      );
      conversation.messages.push(assistantMsg);

      if (queuedTurnCtx) {
        setConversationOriginChannelIfUnset(
          conversation.conversationId,
          queuedTurnCtx.userMessageChannel,
        );
      }
      if (queuedInterfaceCtx) {
        setConversationOriginInterfaceIfUnset(
          conversation.conversationId,
          queuedInterfaceCtx.userMessageInterface,
        );
      }

      // Emit fresh model info before the text delta so the client has
      // up-to-date configuredProviders when rendering /model or /models UI.
      if (isModelSlashCommand(next.content)) {
        next.onEvent(await buildModelInfoEvent(conversation.conversationId));
      }
      next.onEvent({
        type: "assistant_text_delta",
        text: slashResult.message,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Unknown slash command handled",
        {
          requestId: next.requestId,
          status: "success",
        },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to persist unknown-slash exchange",
      );
      conversation.traceEmitter.emit(
        "request_error",
        `Unknown-slash persist failed: ${message}`,
        {
          requestId: next.requestId,
          status: "error",
          attributes: { reason: "persist_failure" },
        },
      );
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });
    }
    // Continue draining regardless of success/failure
    await drainQueue(conversation);
    return;
  }

  // /compact — force context compaction, persist exchange, continue draining.
  if (slashResult.kind === "compact") {
    let persistedCompactMessage = false;
    try {
      const drainProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? {
              userMessageChannel: queuedTurnCtx.userMessageChannel,
              assistantMessageChannel: queuedTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(queuedInterfaceCtx
          ? {
              userMessageInterface: queuedInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                queuedInterfaceCtx.assistantMessageInterface,
            }
          : {}),
        sentAt: next.sentAt,
      };
      const cleanUserMsg = createUserMessage(next.content, next.attachments);
      await addMessage(
        conversation.conversationId,
        "user",
        serializePersistedUserMessageContent(
          next.content,
          next.attachments,
          next.displayContent,
        ),
        { metadata: drainChannelMeta },
      );
      persistedCompactMessage = true;
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState("thinking", "context_compacting", {
        requestId: next.requestId,
      });
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: { ...drainChannelMeta, sentAt: Date.now() } },
      );
      conversation.messages.push(assistantMsg);

      next.onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Compact slash command handled",
        { requestId: next.requestId, status: "success" },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
    } catch (err) {
      if (persistedCompactMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to execute /compact",
      );
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });
    }
    await drainQueue(conversation);
    return;
  }

  // /clean — strip runtime injections and reset memory state, no LLM call.
  if (slashResult.kind === "clean") {
    let persistedCleanMessage = false;
    try {
      const drainProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? {
              userMessageChannel: queuedTurnCtx.userMessageChannel,
              assistantMessageChannel: queuedTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(queuedInterfaceCtx
          ? {
              userMessageInterface: queuedInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                queuedInterfaceCtx.assistantMessageInterface,
            }
          : {}),
        sentAt: next.sentAt,
      };
      const cleanUserMsg = createUserMessage(next.content, next.attachments);
      await addMessage(
        conversation.conversationId,
        "user",
        serializePersistedUserMessageContent(
          next.content,
          next.attachments,
          next.displayContent,
        ),
        { metadata: drainChannelMeta },
      );
      persistedCleanMessage = true;
      conversation.messages.push(cleanUserMsg);

      const result = await conversation.forceClean();
      const responseText = formatCleanResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: { ...drainChannelMeta, sentAt: Date.now() } },
      );
      conversation.messages.push(assistantMsg);

      next.onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Clean slash command handled",
        { requestId: next.requestId, status: "success" },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
    } catch (err) {
      if (persistedCleanMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to execute /clean",
      );
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });
    }
    await drainQueue(conversation);
    return;
  }

  const resolvedContent = slashResult.content;

  // Guardian verification intent interception for queued messages.
  // Preserve the original user content for persistence; only the agent
  // loop receives the rewritten instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const verificationIntent =
      resolveVerificationSessionIntent(resolvedContent);
    if (verificationIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: conversation.conversationId,
          channelHint: verificationIntent.channelHint,
        },
        "Verification session intent intercepted in queue — forcing skill flow",
      );
      agentLoopContent = verificationIntent.rewrittenContent;
      conversation.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  // Try to persist and run the dequeued message. If persistUserMessage
  // succeeds, runAgentLoop is called and its finally block will drain
  // the next message. If persistUserMessage fails, processMessage
  // resolves early (no runAgentLoop call), so we must continue draining.
  let persistResult: { id: string; deduplicated: boolean };
  try {
    persistResult = await conversation.persistUserMessage({
      content: resolvedContent,
      attachments: next.attachments,
      requestId: next.requestId,
      metadata: { ...next.metadata, sentAt: next.sentAt },
      displayContent: next.displayContent,
      clientMessageId: next.clientMessageId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err,
        conversationId: conversation.conversationId,
        requestId: next.requestId,
      },
      "Failed to persist queued message",
    );
    conversation.traceEmitter.emit(
      "request_error",
      `Queued message persist failed: ${message}`,
      {
        requestId: next.requestId,
        status: "error",
        attributes: { reason: "persist_failure" },
      },
    );
    next.onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      message,
    });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    // Continue draining — don't strand remaining messages
    await drainQueue(conversation);
    return;
  }

  const userMessageId = persistResult.id;

  if (persistResult.deduplicated) {
    log.info(
      { conversationId: conversation.conversationId, userMessageId },
      "Skipping agent loop for deduplicated queued message",
    );
    conversation.preactivatedSkillIds = undefined;
    await drainQueue(conversation);
    return;
  }

  // Broadcast the user message to all hub subscribers so passive devices
  // see the user turn before the assistant reply starts streaming.
  next.onEvent({
    type: "user_message_echo",
    text: resolvedContent,
    conversationId: conversation.conversationId,
    messageId: userMessageId,
    requestId: next.requestId,
    clientMessageId: next.clientMessageId,
  });
  publishConversationMessagesChanged(conversation.conversationId);

  // Set the active surface for the dequeued message so runAgentLoop can inject context
  conversation.currentActiveSurfaceId = next.activeSurfaceId;
  conversation.currentPage = next.currentPage;

  // Fire-and-forget: detect notification preferences in the queued message
  // and persist any that are found, mirroring the logic in processMessage.
  if (conversation.assistantId) {
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: conversation.conversationId,
          },
          "Persisted extracted notification preferences (queued)",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: conversation.conversationId },
          "Background preference extraction failed (queued)",
        );
      });
  }

  // Fire-and-forget: persistUserMessage set the processing flag to true
  // so subsequent messages will still be enqueued.
  // runAgentLoop's finally block will call drainQueue when this run completes.
  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  if (next.isInteractive !== undefined)
    drainLoopOptions.isInteractive = next.isInteractive;
  if (agentLoopContent !== resolvedContent)
    drainLoopOptions.titleText = resolvedContent;

  conversation
    .runAgentLoop(agentLoopContent, userMessageId, {
      ...drainLoopOptions,
      onEvent: next.onEvent,
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Error processing queued message",
      );
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message: `Failed to process queued message: ${message}`,
      });
    });
}

// Drives a batched turn where multiple queued passthrough messages share one
// runAgentLoop run. Per-message dequeue events and DB persistence are
// preserved; the agent reply fans out to every batched client.
async function drainBatch(
  conversation: Conversation,
  batch: QueuedMessage[],
  reason: QueueDrainReason,
): Promise<void> {
  // Head-wins: the batch-builder guarantees identical userMessageInterface
  // across the batch; channel/transport divergence is accepted with the head's
  // environment.
  const head = batch[0];

  // Reset per-turn preactivation so a prior iteration can't leak CU
  // preactivation into this batched turn.
  conversation.preactivatedSkillIds = undefined;

  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: head.requestId,
      reason,
      batchSize: batch.length,
    },
    "Dequeuing batched messages",
  );

  const queuedTurnCtx = resolveQueuedTurnContext(
    head,
    conversation.getTurnChannelContext(),
  );
  if (queuedTurnCtx) {
    conversation.setTurnChannelContext(queuedTurnCtx);
  }

  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    head,
    conversation.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) {
    conversation.setTurnInterfaceContext(queuedInterfaceCtx);
  }

  // Apply transport hints from the head message so this batched turn uses
  // the head's transport metadata. Tail transport divergence is accepted
  // per the head-wins contract.
  if (head.transport) {
    conversation.setTransportHints(buildTransportHints(head.transport));
    conversation.applyHostEnvFromTransport(head.transport);
    conversation.applyClientTimezoneFromTransport(head.transport);
  }

  conversation.currentTurnAuthContext = head.authContext;
  conversation.currentTurnSourceActorPrincipalId = head.sourceActorPrincipalId;

  // Re-attach and re-preactivate host-proxy skills for interactive turns.
  // Mirrors the single-message path exactly — sourced from `head`.
  if (head.isInteractive !== false) {
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    const sourceActorPrincipalId = head.sourceActorPrincipalId;
    conversation.ensureHostProxiesForTurn(
      sourceInterface,
      sourceActorPrincipalId,
    );
    preactivateHostProxySkills(
      conversation,
      sourceInterface,
      sourceActorPrincipalId,
    );
  }

  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;

  // Single activity-state transition for the batched turn. Per-message
  // emissions would publish N "thinking" phase transitions to every
  // connected SSE client (via activityVersion increments), whipsawing the
  // client-side thinking indicator. The single-message path emits exactly
  // one such event per turn; match it here.
  conversation.emitActivityState("thinking", "message_dequeued", {
    requestId: head.requestId,
  });

  // Per-message dequeue events and persistence loop. Track the last
  // SUCCESSFUL persist separately from the batch tail — a failed tail
  // must not corrupt the requestId/surface context that `runAgentLoop`
  // will tag `message_complete` / `generation_cancelled` with.
  let lastSuccessfulRequestId: string | undefined;
  let lastSuccessfulActiveSurfaceId: string | undefined;
  let lastSuccessfulCurrentPage: string | undefined;
  let lastSuccessfulContent: string | undefined;
  let lastUserMessageId: string | undefined;
  // Members whose persist succeeded. `fanOutOnEvent` below must only
  // broadcast agent-loop events to these — clients whose persist failed
  // already received an error event and must not also receive the
  // assistant's streaming response for a turn that isn't theirs.
  const successfulBatch: QueuedMessage[] = [];
  for (let i = 0; i < batch.length; i++) {
    const qm = batch[i];
    qm.onEvent({
      type: "message_dequeued",
      conversationId: conversation.conversationId,
      requestId: qm.requestId,
    });
    conversation.traceEmitter.emit(
      "request_dequeued",
      "Message dequeued (batched)",
      {
        requestId: qm.requestId,
        status: "info",
        attributes: { reason, batchIndex: i, batchSize: batch.length },
      },
    );

    const qmSlash = await resolveSlash(
      qm.content,
      buildSlashContext(qm.content, conversation),
    );
    if (qmSlash.kind !== "passthrough") {
      // Defensive recovery. `buildPassthroughBatch` should make this
      // unreachable, but if it ever fires we must avoid stranding
      // per-turn state and dropping the batch tails that have already
      // been shifted out of the queue. Log, emit an error to the
      // affected client, and either recover-and-drain (head case) or
      // skip the tail (tail case) so the rest of the batch still runs.
      const invariantMessage =
        "Internal error: batch drain invariant violated (non-passthrough message in batch)";
      log.error(
        {
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
          batchSize: batch.length,
          slashKind: qmSlash.kind,
        },
        "drainBatch invariant violated — non-passthrough message found in batch",
      );
      conversation.traceEmitter.emit("request_error", invariantMessage, {
        requestId: qm.requestId,
        status: "error",
        attributes: { reason: "batch_invariant_violation" },
      });
      qm.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message: invariantMessage,
      });
      if (i === 0) {
        // Head invariant fired — no in-flight turn yet (the check runs
        // before persistUserMessage, so the head was never persisted).
        // Clear per-turn state and recursively drain the remaining tails,
        // which were already shifted out of the queue by
        // buildPassthroughBatch and would otherwise be stranded. Mirrors
        // the head persist-failure recovery below.
        conversation.setProcessing(false);
        conversation.abortController = null;
        conversation.currentRequestId = undefined;
        conversation.preactivatedSkillIds = undefined;
        const remaining = batch.slice(1);
        if (remaining.length >= 2) {
          await drainBatch(conversation, remaining, reason);
        } else if (remaining.length === 1) {
          await drainSingleMessage(conversation, remaining[0], reason);
        } else {
          await drainQueue(conversation);
        }
        return;
      }
      // Tail case — processing is live, just skip this message. Loop
      // continues to drain any remaining tails.
      continue;
    }
    const qmContent = qmSlash.content;

    try {
      let batchPersistResult: { id: string; deduplicated: boolean };
      const persistOptions = {
        content: qmContent,
        attachments: qm.attachments,
        requestId: qm.requestId,
        metadata: { ...qm.metadata, sentAt: qm.sentAt },
        displayContent: qm.displayContent,
        clientMessageId: qm.clientMessageId,
      };
      if (i === 0) {
        batchPersistResult =
          await conversation.persistUserMessage(persistOptions);
      } else {
        batchPersistResult = await persistQueuedMessageBody(
          conversation,
          persistOptions,
        );
      }
      if (batchPersistResult.deduplicated) {
        if (i === 0) {
          // Head was deduplicated — persistUserMessage cleared the
          // processing flag. Recursively drain remaining items so the
          // first non-duplicate becomes the new batch head and sets
          // processing via persistUserMessage.
          const remaining = batch.slice(1);
          if (remaining.length >= 2) {
            await drainBatch(conversation, remaining, reason);
          } else if (remaining.length === 1) {
            await drainSingleMessage(conversation, remaining[0], reason);
          } else {
            await drainQueue(conversation);
          }
          return;
        }
        continue;
      }
      lastUserMessageId = batchPersistResult.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
        },
        "Failed to persist batched queued message",
      );
      conversation.traceEmitter.emit(
        "request_error",
        `Queued message persist failed: ${message}`,
        {
          requestId: qm.requestId,
          status: "error",
          attributes: { reason: "persist_failure" },
        },
      );
      qm.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });

      if (i === 0) {
        // Head persist failed — processing is not set yet, no in-flight turn
        // to fan tails into. We've already shifted the tails out of the queue
        // as part of this batch, so if we simply called drainQueue the tails
        // would be stranded. Reset per-turn state and recursively drain the
        // remaining tails (they're still valid by the batch invariant).
        conversation.preactivatedSkillIds = undefined;
        const remaining = batch.slice(1);
        if (remaining.length >= 2) {
          await drainBatch(conversation, remaining, reason);
        } else if (remaining.length === 1) {
          await drainSingleMessage(conversation, remaining[0], reason);
        } else {
          await drainQueue(conversation);
        }
        return;
      }
      // Tail persist failed — we cannot abandon the batch without stranding
      // the head's in-flight turn. Processing state is already set; skip
      // this message and continue accumulating siblings. The emitted error
      // event lets the tail client see the failure. Crucially we do NOT
      // update lastSuccessful* here, so runAgentLoop tags completion with
      // the most recent successfully-persisted message's requestId.
      continue;
    }

    // Broadcast the user message to all hub subscribers so passive devices
    // see each batched user turn before the assistant reply starts streaming.
    qm.onEvent({
      type: "user_message_echo",
      text: qmContent,
      conversationId: conversation.conversationId,
      messageId: lastUserMessageId,
      requestId: qm.requestId,
      clientMessageId: qm.clientMessageId,
    });
    publishConversationMessagesChanged(conversation.conversationId);

    // Persist succeeded. Update last-successful markers so a later tail
    // failure won't overwrite them.
    lastSuccessfulRequestId = qm.requestId;
    lastSuccessfulActiveSurfaceId = qm.activeSurfaceId;
    lastSuccessfulCurrentPage = qm.currentPage;
    lastSuccessfulContent = qmContent;
    successfulBatch.push(qm);

    // Fire-and-forget: detect notification preferences in each batched user
    // message and persist any that are found, mirroring drainSingleMessage.
    if (conversation.assistantId) {
      extractPreferences(qmContent)
        .then((result) => {
          if (!result.detected) return;
          for (const pref of result.preferences) {
            createPreference({
              preferenceText: pref.preferenceText,
              appliesWhen: pref.appliesWhen,
              priority: pref.priority,
            });
          }
          log.info(
            {
              count: result.preferences.length,
              conversationId: conversation.conversationId,
            },
            "Persisted extracted notification preferences (batched)",
          );
        })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(
            { err: errMsg, conversationId: conversation.conversationId },
            "Background preference extraction failed (batched)",
          );
        });
    }

    // If the user hit abort mid-batch, stop persisting remaining tails.
    // runAgentLoop's existing abort handling will emit generation_cancelled
    // and clear processing state for whatever did persist.
    if (conversation.abortController?.signal.aborted) {
      log.info(
        {
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
          batchSize: batch.length,
        },
        "drainBatch: abort signaled mid-batch; stopping tail persist",
      );
      break;
    }
  }

  if (lastUserMessageId === undefined || lastSuccessfulContent === undefined) {
    // Nothing persisted — either the head's invariant-violation recovery
    // already drained and returned, or every message failed. Head failure
    // has its own recovery path above; if we get here it's because a
    // defensive code path left us with nothing to run. Log and bail.
    log.error(
      {
        conversationId: conversation.conversationId,
        batchSize: batch.length,
      },
      "drainBatch: no messages persisted successfully; skipping runAgentLoop",
    );
    conversation.preactivatedSkillIds = undefined;
    return;
  }

  // Tag turn-completion state with the last SUCCESSFUL persist so client-
  // side correlation (message_complete / generation_cancelled /
  // generation_handoff) surfaces a requestId that actually has a DB row.
  conversation.currentRequestId = lastSuccessfulRequestId;
  conversation.currentActiveSurfaceId = lastSuccessfulActiveSurfaceId;
  conversation.currentPage = lastSuccessfulCurrentPage;

  // Broadcast agent-loop events only to unique sinks whose persist succeeded.
  // Multiple web-queued messages share the same broadcastMessage callback; if
  // we call it once per queued message, every text delta is published N times
  // to the same SSE stream and the client renders duplicated text.
  //
  // Members whose persist failed already received an error event in the catch
  // block above; sending them the assistant's streaming response would surface
  // a reply for a user message that isn't in their DB.
  const successfulEventSinks = Array.from(
    new Set(successfulBatch.map((qm) => qm.onEvent)),
  );
  const fanOutOnEvent = (msg: ServerMessage) => {
    for (const onEvent of successfulEventSinks) onEvent(msg);
  };

  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  // Source interactive flag from the last successfully-persisted sibling so
  // a trailing failed tail doesn't flip the agent loop's interactivity.
  const lastSuccessfulBatchEntry =
    successfulBatch.length > 0
      ? successfulBatch[successfulBatch.length - 1]
      : undefined;
  if (lastSuccessfulBatchEntry?.isInteractive !== undefined)
    drainLoopOptions.isInteractive = lastSuccessfulBatchEntry.isInteractive;

  // Fire-and-forget: runAgentLoop's finally block recursively calls drainQueue
  // when this run completes. Mirrors drainSingleMessage.
  conversation
    .runAgentLoop(lastSuccessfulContent, lastUserMessageId, {
      ...drainLoopOptions,
      onEvent: fanOutOnEvent,
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: lastSuccessfulRequestId,
          batchSize: batch.length,
        },
        "Error processing batched queued messages",
      );
      fanOutOnEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message: `Failed to process queued messages: ${message}`,
      });
    });
}

// ── ProcessMessageOptions ────────────────────────────────────────────

/** Options for `processMessage`. Only `content` and `attachments` are
 *  required; everything else has a sensible default or is genuinely optional. */
export interface ProcessMessageOptions {
  content: string;
  attachments: UserMessageAttachment[];
  onEvent?: (msg: ServerMessage) => void;
  requestId?: string;
  activeSurfaceId?: string;
  currentPage?: string;
  isInteractive?: boolean;
  callSite?: LLMCallSite;
  /**
   * Optional ad-hoc inference-profile override applied to every LLM call
   * this turn issues (e.g. a schedule's pinned profile). Forwarded to
   * {@link Conversation.runAgentLoop}.
   */
  overrideProfile?: string;
  displayContent?: string;
}

// ── processMessage ───────────────────────────────────────────────────

/**
 * Convenience function that persists a user message and runs the agent loop
 * in a single call. Used by the message-handler path where blocking is expected.
 */
export async function processMessage(
  conversation: Conversation,
  options: ProcessMessageOptions,
): Promise<string> {
  const {
    content,
    attachments,
    onEvent = () => {},
    requestId,
    activeSurfaceId,
    currentPage,
    isInteractive,
    callSite,
    overrideProfile,
    displayContent,
  } = options;
  await conversation.ensureActorScopedHistory();
  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnAuthContext = conversation.authContext;
  conversation.currentTurnSourceActorPrincipalId =
    conversation.authContext?.actorPrincipalId;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;
  conversation.currentActiveSurfaceId = activeSurfaceId;
  conversation.currentPage = currentPage;
  const trimmedContent = content.trim();
  const canonicalPendingRequestHintIdsForConversation =
    trimmedContent.length > 0
      ? listPendingRequestsByConversationScope(
          conversation.conversationId,
          "vellum",
        ).map((request) => request.id)
      : [];
  const canonicalPendingRequestIdsForConversation =
    canonicalPendingRequestHintIdsForConversation.length > 0
      ? canonicalPendingRequestHintIdsForConversation
      : undefined;

  // ── Canonical guardian reply router (desktop/conversation path) ──
  // Desktop/conversation guardian replies are canonical-only. Messages consumed
  // by the router never hit the general agent loop.
  if (trimmedContent.length > 0) {
    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: "vellum",
      actor: {
        actorPrincipalId:
          conversation.trustContext?.guardianPrincipalId ?? undefined,
        actorExternalUserId: conversation.trustContext?.guardianExternalUserId,
        channel: "vellum",
        guardianPrincipalId:
          conversation.trustContext?.guardianPrincipalId ?? undefined,
      },
      conversationId: conversation.conversationId,
      pendingRequestIds: canonicalPendingRequestIdsForConversation,
      // Desktop path: disable NL classification to avoid consuming non-decision
      // messages while a tool confirmation is pending. Deterministic code-prefix
      // and callback parsing remain active.
      approvalConversationGenerator: undefined,
    });

    if (routerResult.consumed) {
      const guardianIfCtx = conversation.getTurnInterfaceContext();
      const guardianImageSourcePaths: Record<string, string> = {};
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
          guardianImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
        }
      }
      const routerChannelMeta = {
        userMessageChannel: "vellum" as const,
        assistantMessageChannel: "vellum" as const,
        userMessageInterface: guardianIfCtx?.userMessageInterface ?? "web",
        assistantMessageInterface:
          guardianIfCtx?.assistantMessageInterface ?? "web",
        provenanceTrustClass: "guardian" as const,
        ...(Object.keys(guardianImageSourcePaths).length > 0
          ? { imageSourcePaths: guardianImageSourcePaths }
          : {}),
      };

      const cleanUserMsg = createUserMessage(content, attachments);
      const llmUserMsg = enrichMessageWithSourcePaths(
        cleanUserMsg,
        attachments,
      );
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        serializePersistedUserMessageContent(
          content,
          attachments,
          displayContent,
        ),
        { metadata: routerChannelMeta },
      );
      conversation.messages.push(llmUserMsg);

      const replyText =
        routerResult.replyText ??
        (routerResult.decisionApplied
          ? "Decision applied."
          : "Request already resolved.");
      const assistantMsg = createAssistantMessage(replyText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: routerChannelMeta },
      );
      conversation.messages.push(assistantMsg);

      onEvent({
        type: "assistant_text_delta",
        text: replyText,
        conversationId: conversation.conversationId,
      });
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });

      log.info(
        {
          conversationId: conversation.conversationId,
          routerType: routerResult.type,
          requestId: routerResult.requestId,
        },
        "Conversation guardian reply routed through canonical pipeline",
      );

      return persisted.id;
    }
  }

  // Resolve slash commands before persistence
  const slashResult = await resolveSlash(
    content,
    buildSlashContext(content, conversation),
  );

  // Unknown slash command — persist the exchange (user + assistant) so the
  // messageId is real.  Persist each message before pushing to conversation.messages
  // so that a failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    const pmTurnCtx = conversation.getTurnChannelContext();
    const pmInterfaceCtx = conversation.getTurnInterfaceContext();
    const pmProvenance = provenanceFromTrustContext(conversation.trustContext);
    const pmImageSourcePaths: Record<string, string> = {};
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
        pmImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
      }
    }
    const pmChannelMeta = {
      ...pmProvenance,
      ...(pmTurnCtx
        ? {
            userMessageChannel: pmTurnCtx.userMessageChannel,
            assistantMessageChannel: pmTurnCtx.assistantMessageChannel,
          }
        : {}),
      ...(pmInterfaceCtx
        ? {
            userMessageInterface: pmInterfaceCtx.userMessageInterface,
            assistantMessageInterface: pmInterfaceCtx.assistantMessageInterface,
          }
        : {}),
      ...(Object.keys(pmImageSourcePaths).length > 0
        ? { imageSourcePaths: pmImageSourcePaths }
        : {}),
    };
    const cleanUserMsg = createUserMessage(content, attachments);
    const llmUserMsg = enrichMessageWithSourcePaths(cleanUserMsg, attachments);
    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message.
    // The in-memory userMessage (sent to the LLM) still uses the stripped content.
    const contentToPersist = serializePersistedUserMessageContent(
      content,
      attachments,
      displayContent,
    );
    const persisted = await addMessage(
      conversation.conversationId,
      "user",
      contentToPersist,
      { metadata: pmChannelMeta },
    );
    conversation.messages.push(llmUserMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    await addMessage(
      conversation.conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      { metadata: pmChannelMeta },
    );
    conversation.messages.push(assistantMsg);

    if (pmTurnCtx) {
      setConversationOriginChannelIfUnset(
        conversation.conversationId,
        pmTurnCtx.userMessageChannel,
      );
    }
    if (pmInterfaceCtx) {
      setConversationOriginInterfaceIfUnset(
        conversation.conversationId,
        pmInterfaceCtx.userMessageInterface,
      );
    }

    // Emit fresh model info before the text delta so the client has
    // up-to-date configuredProviders when rendering /model or /models UI.
    if (isModelSlashCommand(content)) {
      onEvent(await buildModelInfoEvent(conversation.conversationId));
    }
    onEvent({
      type: "assistant_text_delta",
      text: slashResult.message,
      conversationId: conversation.conversationId,
    });
    conversation.traceEmitter.emit(
      "message_complete",
      "Unknown slash command handled",
      {
        requestId,
        status: "success",
      },
    );
    onEvent({
      type: "message_complete",
      conversationId: conversation.conversationId,
    });
    publishConversationMessagesChanged(conversation.conversationId);
    return persisted.id;
  }

  // /compact — force context compaction, persist exchange, return message ID.
  if (slashResult.kind === "compact") {
    conversation.setProcessing(true);
    let persistedCompactMessage = false;
    try {
      const pmTurnCtx = conversation.getTurnChannelContext();
      const pmInterfaceCtx = conversation.getTurnInterfaceContext();
      const pmProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const pmChannelMeta = {
        ...pmProvenance,
        ...(pmTurnCtx
          ? {
              userMessageChannel: pmTurnCtx.userMessageChannel,
              assistantMessageChannel: pmTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(pmInterfaceCtx
          ? {
              userMessageInterface: pmInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                pmInterfaceCtx.assistantMessageInterface,
            }
          : {}),
      };
      const cleanUserMsg = createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        serializePersistedUserMessageContent(
          content,
          attachments,
          displayContent,
        ),
        { metadata: pmChannelMeta },
      );
      persistedCompactMessage = true;
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState("thinking", "context_compacting", {
        requestId,
      });
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: pmChannelMeta },
      );
      conversation.messages.push(assistantMsg);

      onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Compact slash command handled",
        { requestId, status: "success" },
      );
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
      return persisted.id;
    } catch (err) {
      if (persistedCompactMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      throw err;
    } finally {
      conversation.setProcessing(false);
      await drainQueue(conversation);
    }
  }

  // /clean — strip runtime injections, return message ID. No LLM call.
  if (slashResult.kind === "clean") {
    conversation.setProcessing(true);
    let persistedCleanMessage = false;
    try {
      const pmTurnCtx = conversation.getTurnChannelContext();
      const pmInterfaceCtx = conversation.getTurnInterfaceContext();
      const pmProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const pmChannelMeta = {
        ...pmProvenance,
        ...(pmTurnCtx
          ? {
              userMessageChannel: pmTurnCtx.userMessageChannel,
              assistantMessageChannel: pmTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(pmInterfaceCtx
          ? {
              userMessageInterface: pmInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                pmInterfaceCtx.assistantMessageInterface,
            }
          : {}),
      };
      const cleanUserMsg = createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        serializePersistedUserMessageContent(
          content,
          attachments,
          displayContent,
        ),
        { metadata: pmChannelMeta },
      );
      persistedCleanMessage = true;
      conversation.messages.push(cleanUserMsg);

      const result = await conversation.forceClean();
      const responseText = formatCleanResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: pmChannelMeta },
      );
      conversation.messages.push(assistantMsg);

      onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Clean slash command handled",
        { requestId, status: "success" },
      );
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
      return persisted.id;
    } catch (err) {
      if (persistedCleanMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      throw err;
    } finally {
      conversation.setProcessing(false);
      await drainQueue(conversation);
    }
  }

  const resolvedContent = slashResult.content;

  // Guardian verification intent interception — force direct guardian
  // verification requests into the guardian-verify-setup skill flow on
  // the first turn, avoiding conceptual preambles from the agent.
  // We keep the original user content for persistence and use the
  // rewritten content only for the agent loop instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const verificationIntent =
      resolveVerificationSessionIntent(resolvedContent);
    if (verificationIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: conversation.conversationId,
          channelHint: verificationIntent.channelHint,
        },
        "Verification session intent intercepted — forcing skill flow",
      );
      agentLoopContent = verificationIntent.rewrittenContent;
      conversation.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  let pmResult: { id: string; deduplicated: boolean };
  try {
    pmResult = await conversation.persistUserMessage({
      content: resolvedContent,
      attachments,
      requestId,
      displayContent,
    });
    publishConversationMessagesChanged(conversation.conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      message,
    });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    return "";
  }

  const userMessageId = pmResult.id;

  // Fire-and-forget: detect notification preferences in the user message
  // and persist any that are found. Runs in the background so it doesn't
  // block the main conversation flow.
  if (conversation.assistantId) {
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: conversation.conversationId,
          },
          "Persisted extracted notification preferences",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: conversation.conversationId },
          "Background preference extraction failed",
        );
      });
  }

  const loopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
    callSite?: LLMCallSite;
    overrideProfile?: string;
  } = { isUserMessage: true };
  if (isInteractive !== undefined) loopOptions.isInteractive = isInteractive;
  if (agentLoopContent !== resolvedContent)
    loopOptions.titleText = resolvedContent;
  if (callSite !== undefined) loopOptions.callSite = callSite;
  if (overrideProfile !== undefined)
    loopOptions.overrideProfile = overrideProfile;

  await conversation.runAgentLoop(agentLoopContent, userMessageId, {
    ...loopOptions,
    onEvent,
  });
  return userMessageId;
}
