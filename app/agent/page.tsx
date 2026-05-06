"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  DefaultChatTransport,
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { useChat } from "@ai-sdk/react";
import ReactMarkdown from "react-markdown";
import { Brain, ChevronDown, ExternalLink, Loader2, Paperclip, Plus, SendHorizontal, Sparkles, Trash2, X } from "lucide-react";
import { WorkflowCanvasById } from "@/components/agent/agent-workflow-canvas";
import { Button } from "@/components/ui/button";

type DbMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

type ChatSession = {
  id: string;
  title: string | null;
  status: string;
  messages: DbMessage[];
};

type CommandContextSummary = {
  signals?: Record<string, boolean>;
  playbooks?: Array<{ id: string; name: string; type: string }>;
  recentEligibleWorkflows?: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: string;
  }>;
  referencedWorkflow?: {
    id: string;
    type: string;
    status: string;
    createdAt: string;
  } | null;
  recentDrafts?: number;
  relevantBriefs?: number;
};

type CommandResponse = {
  ok: boolean;
  intent: string;
  tool: string | null;
  result?: unknown;
  message: string;
  contextSummary?: CommandContextSummary;
};

const TOOL_LABELS: Record<string, string> = {
  getBrandProfile: "Getting brand profile",
  updateBrandProfile: "Updating brand profile",
  analyzeStore: "Analyzing store",
  generateEmailContent: "Generating email",
  analyzeDocument: "Analyzing document",
  findCompetitors: "Finding competitors",
  analyzeCompetitorSite: "Analyzing competitor site",
  analyzeCompetitorEmail: "Analyzing competitor email",
  getCustomerStats: "Loading customer stats",
  searchBrandDocuments: "Searching brand documents",
};

const THINKING_ROTATION = [
  "Stalking your brand (professionally)...",
  "Consulting the marketing gods...",
  "Crunching some seriously sexy data...",
  "Making your competitors nervous...",
  "Downloading marketing genius...",
  "Having a eureka moment...",
  "My neurons are firing...",
  "Brewing up something good...",
];

const AUDIT_STARTER_TEXT =
  "Want me to audit your retention setup? I can check products, campaigns, flows, audiences, performance readiness, and lifecycle coverage, then tell you what needs fixing.";

const OLD_GENERIC_GREETING_PATTERN = /Hey!.*I'm Worklin.*your AI retention marketer.*What are we working on\?/i;

function mapDbRoleToUi(role: string): "user" | "assistant" {
  if (role === "user") return "user";
  return "assistant";
}

function messagesFromDb(rows: DbMessage[]): UIMessage[] {
  return rows.map((m) => ({
    id: m.id,
    role: mapDbRoleToUi(m.role),
    parts: [
      {
        type: "text" as const,
        text: OLD_GENERIC_GREETING_PATTERN.test(m.content) ? AUDIT_STARTER_TEXT : m.content,
        state: "done" as const,
      },
    ],
  }));
}

/** Collect visible text from any message part (text, reasoning, tool output fallbacks). */
function getRenderableTextParts(parts: UIMessage["parts"]): Array<{ key: string; text: string; kind: "text" | "reasoning" }> {
  const out: Array<{ key: string; text: string; kind: "text" | "reasoning" }> = [];
  let i = 0;
  for (const part of parts) {
    const p = part as { type?: string; text?: string };
    if (isTextUIPart(part as never) && p.text) {
      out.push({ key: `t-${i}`, text: p.text, kind: "text" });
    } else if (isReasoningUIPart(part as never) && p.text) {
      out.push({ key: `r-${i}`, text: p.text, kind: "reasoning" });
    }
    i += 1;
  }
  return out;
}

function messageText(message: UIMessage) {
  return getRenderableTextParts(message.parts)
    .map((part) => part.text)
    .join("\n");
}

function isAuditStarterOnly(messages: UIMessage[]) {
  return messages.length === 1 &&
    messages[0].role === "assistant" &&
    /Want me to audit your retention setup\?/i.test(messageText(messages[0]));
}

function toolLineFromPart(part: unknown): string | null {
  if (!isToolUIPart(part as never)) return null;
  const name = getToolName(part as never);
  const label = TOOL_LABELS[name] ?? name.replace(/([A-Z])/g, " $1").trim();
  const p = part as { state?: string };
  if (p.state === "input-streaming" || p.state === "input-available") {
    return `🔧 ${label}...`;
  }
  if (p.state === "output-available") {
    return `🔧 ${label} — done`;
  }
  if (p.state === "output-error") {
    return `🔧 ${label} — error`;
  }
  return `🔧 ${label}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detectsApprovalIntent(message: string) {
  return (
    /\bapproved?\b/i.test(message) ||
    /\blooks?\s+good\b/i.test(message) ||
    /\bgo\s+ahead\b/i.test(message) ||
    /\bapprove\s+(these|them|the\s+ready\s+ones|ready\s+ones)\b/i.test(message) ||
    /\bship\s+the\s+drafts?\b/i.test(message)
  );
}

function detectsSendOrScheduleIntent(message: string) {
  return (
    /\b(send|sending|sent|schedule|scheduled|scheduling|launch|launching|go\s+live)\b/i.test(message) ||
    /\b(sync|syncing|push|publish)\b.*\b(segments?|profiles?|flows?|campaigns?|klaviyo)\b/i.test(message) ||
    /\b(create|update|delete|remove|change|modify|activate|enable)\b.*\b(live\s+)?(klaviyo\s+)?flows?\b/i.test(message) ||
    /\b(create|update|delete|remove|change|modify)\b.*\b(live\s+)?(segments?|profiles?)\b/i.test(message) ||
    /\bdestructive\b.*\bklaviyo\b/i.test(message)
  );
}

function detectsExplicitFixConfirmationIntent(message: string) {
  return (
    /\bfix\s+all\b/i.test(message) ||
    /\bfix\s+(all\s+)?(this|it|these|what\s+you\s+can)\b/i.test(message) ||
    /\bprepare\s+(the\s+)?(safe\s+)?fixes\b/i.test(message) ||
    /\bhandle\s+(the\s+)?safe\s+fixes\b/i.test(message) ||
    /\bprepare\s+everything\s+safe\b/i.test(message) ||
    /\bfix\s+what\s+you\s+can\b/i.test(message)
  );
}

function detectsVagueFixConfirmationIntent(message: string) {
  return /^\s*(yes|yeah|yep|sure|ok|okay|do it|go ahead|please do)\s*[.!]?\s*$/i.test(message);
}

function recentAssistantAskedForSafeFixes(messages: DbMessage[]) {
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 4); index -= 1) {
    const message = messages[index];
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    return /want\s+me\s+to\s+prepare\s+the\s+safe\s+fixes/i.test(message.content);
  }
  return false;
}

function workflowUrl(workflowId: string) {
  return `/agent/workflows?workflowId=${encodeURIComponent(workflowId)}`;
}

function extractWorkflowIdFromText(text: string) {
  const queryMatch = text.match(/workflowId=([A-Za-z0-9_-]+)/);
  if (queryMatch?.[1]) return queryMatch[1];
  const labelMatch = text.match(/\bWorkflow(?: ID)?:\s*`?([A-Za-z0-9_-]+)`?/i);
  return labelMatch?.[1] ?? null;
}

function findLatestWorkflowId(messages: DbMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const workflowId = extractWorkflowIdFromText(messages[index].content);
    if (workflowId) return workflowId;
  }
  return null;
}

function getWorkflowIdFromCommand(response: CommandResponse) {
  const result = isRecord(response.result) ? response.result : {};
  const direct = asString(result.workflowId);
  if (direct) return direct;

  const workflow = isRecord(result.workflow) ? result.workflow : null;
  const workflowId = asString(workflow?.id);
  if (workflowId) return workflowId;

  return response.contextSummary?.referencedWorkflow?.id ?? null;
}

function formatWorkflowLines(response: CommandResponse) {
  if (response.intent === "retention_audit" || response.intent === "audit_fix_run") return [];

  const result = isRecord(response.result) ? response.result : {};
  const workflowId = getWorkflowIdFromCommand(response);
  const lines: string[] = [];

  if (workflowId) {
    lines.push(`Workflow: \`${workflowId}\``);
    lines.push(`[Open workflow in canvas](${workflowUrl(workflowId)})`);
  }

  const workflows = asArray(result.workflows);
  const recentEligible = asArray(result.recentEligibleWorkflows);
  const workflowList = workflows.length ? workflows : recentEligible;

  if (workflowList.length && !workflowId) {
    lines.push("Recent workflows:");
    for (const item of workflowList.slice(0, 4)) {
      if (!isRecord(item)) continue;
      const id = asString(item.id);
      if (!id) continue;
      const status = asString(item.status) ?? "unknown";
      const type = asString(item.type) ?? "workflow";
      lines.push(`- ${type} · ${status}: [open](${workflowUrl(id)})`);
    }
  }

  return lines;
}

function formatPlaybookLines(response: CommandResponse) {
  const result = isRecord(response.result) ? response.result : {};
  const playbooks = asArray(result.playbooks);
  if (!playbooks.length) return [];

  const lines = ["Relevant playbooks:"];
  for (const item of playbooks.slice(0, 6)) {
    if (!isRecord(item)) continue;
    const name = asString(item.name) ?? asString(item.id) ?? "Playbook";
    const type = asString(item.type) ?? "playbook";
    lines.push(`- ${name} (${type})`);
  }
  return lines;
}

function formatDraftLines(response: CommandResponse) {
  const result = isRecord(response.result) ? response.result : {};
  const created = asArray(result.draftsCreated).length;
  const held = asArray(result.held).length;
  const skipped = asArray(result.skipped).length;
  if (!created && !held && !skipped) return [];
  return [`Drafts: ${created} created, ${held} held, ${skipped} skipped. Nothing was scheduled or sent.`];
}

function formatContextSummary(context: CommandContextSummary | undefined) {
  if (!context) return null;
  const activeSignals = Object.entries(context.signals ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const signalText = activeSignals.length ? activeSignals.join(", ") : "none";
  const playbookCount = context.playbooks?.length ?? 0;
  const workflowCount = context.recentEligibleWorkflows?.length ?? 0;
  const draftCount = context.recentDrafts ?? 0;
  const briefCount = context.relevantBriefs ?? 0;
  return `Context: ${signalText} signals · ${playbookCount} playbooks · ${workflowCount} eligible workflows · ${draftCount} drafts · ${briefCount} briefs.`;
}

function formatCommandResponse(response: CommandResponse) {
  const lines = [
    response.message,
    ...formatWorkflowLines(response),
    ...formatPlaybookLines(response),
    ...formatDraftLines(response),
  ].filter(Boolean);

  const contextLine =
    response.intent === "retention_audit" || response.intent === "audit_fix_run"
      ? null
      : formatContextSummary(response.contextSummary);
  if (contextLine) {
    lines.push("");
    lines.push(contextLine);
  }

  return lines.join("\n\n");
}

function AgentChatPanel({
  session,
  onSessionChange,
  sessions,
  onReloadSessions,
}: {
  session: ChatSession;
  onSessionChange: (s: ChatSession) => void;
  sessions: Array<{ id: string; title: string | null; updatedAt: string }>;
  onReloadSessions: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(() => findLatestWorkflowId(session.messages));
  const [canvasWorkflowId, setCanvasWorkflowId] = useState<string | null>(null);
  const [thinkingIdx, setThinkingIdx] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        // Must merge `messages` (and id/trigger/messageId) into the body — returning only
        // sessionId replaces the default payload and the API receives an empty messages array.
        prepareSendMessagesRequest: async ({ body, messages: uiMessages, id, trigger, messageId }) => ({
          body: {
            ...(body ?? {}),
            id,
            messages: uiMessages,
            trigger,
            messageId,
            sessionId: session.id,
          },
        }),
      }),
    [session.id],
  );

  const initialMessages = useMemo(() => messagesFromDb(session.messages), [session]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    id: session.id,
    transport,
    messages: initialMessages,
    onError: (error) => {
      console.error("Chat error:", error);
      setToast(error.message ?? "Something went wrong. Check the console or try again.");
      window.setTimeout(() => setToast(null), 8000);
    },
    onFinish: async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${session.id}`);
        if (!res.ok) return;
        const data = (await res.json()) as { session: ChatSession };
        setMessages(messagesFromDb(data.session.messages));
      } catch {
        // ignore sync errors
      }
    },
  });

  console.log("Messages:", messages);

  useEffect(() => {
    setActiveWorkflowId(findLatestWorkflowId(session.messages));
  }, [session.messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    if (status !== "streaming" && status !== "submitted" && !commandBusy) return;
    const t = window.setInterval(() => {
      setThinkingIdx((i) => (i + 1) % THINKING_ROTATION.length);
    }, 2500);
    return () => clearInterval(t);
  }, [commandBusy, status]);

  const aiBusy = status === "streaming" || status === "submitted";
  const busy = aiBusy || commandBusy;
  const showAuditStarterActions = isAuditStarterOnly(messages) && !busy;

  async function handleNewChat() {
    const res = await fetch("/api/agent/sessions", { method: "POST" });
    const data = (await res.json()) as { session: ChatSession };
    onSessionChange(data.session);
    setCanvasWorkflowId(null);
    await onReloadSessions();
    setPickerOpen(false);
  }

  async function loadSession(id: string) {
    const res = await fetch(`/api/agent/sessions/${id}`);
    const data = (await res.json()) as { session: ChatSession };
    onSessionChange(data.session);
    setCanvasWorkflowId(findLatestWorkflowId(data.session.messages));
    setPickerOpen(false);
  }

  async function deleteSession(id: string) {
    if (!confirm("Delete this chat?")) return;
    const res = await fetch(`/api/agent/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    if (session.id === id) {
      await handleNewChat();
    } else {
      await onReloadSessions();
    }
  }

  async function saveCommandExchange(userText: string, assistantText: string) {
    const res = await fetch(`/api/agent/sessions/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: userText },
          { role: "assistant", content: assistantText },
        ],
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? "Failed to save command response");
    }
    const data = (await res.json()) as { session: ChatSession };
    onSessionChange(data.session);
    setMessages(messagesFromDb(data.session.messages));
    await onReloadSessions();
  }

  async function runCommand(text: string) {
    const promptAskedForSafeFixes = recentAssistantAskedForSafeFixes(session.messages);
    const explicitFixConfirmation = detectsExplicitFixConfirmationIntent(text);
    const vagueFixConfirmation = detectsVagueFixConfirmationIntent(text) && promptAskedForSafeFixes;
    const payload: { message: string; workflowId?: string; safeFixPromptContext?: boolean } = { message: text };
    if (vagueFixConfirmation) {
      payload.safeFixPromptContext = true;
    }
    if (
      activeWorkflowId &&
      (detectsApprovalIntent(text) ||
        detectsSendOrScheduleIntent(text) ||
        explicitFixConfirmation ||
        vagueFixConfirmation)
    ) {
      payload.workflowId = activeWorkflowId;
    }

    const res = await fetch("/api/agent/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => null)) as CommandResponse | null;
    if (!res.ok || !data) {
      throw new Error(data?.message ?? "Command router failed");
    }

    const workflowId = getWorkflowIdFromCommand(data);
    if (workflowId) {
      setActiveWorkflowId(workflowId);
      setCanvasWorkflowId(workflowId);
    }

    await saveCommandExchange(text, formatCommandResponse(data));
  }

  async function runAuditStarter() {
    if (busy) return;
    setCommandBusy(true);
    try {
      await runCommand("Audit my retention setup");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Command router failed");
      window.setTimeout(() => setToast(null), 8000);
    } finally {
      setCommandBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setCommandBusy(true);
    try {
      await runCommand(text);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Command router failed");
      window.setTimeout(() => setToast(null), 8000);
    } finally {
      setCommandBusy(false);
    }
  }

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length || busy) return;
    const file = files[0];
    e.target.value = "";
    try {
      const text = await file.text();
      const intro = `Please analyze this document using your tools.\nFile: ${file.name}\n\n${text.slice(0, 120_000)}`;
      await sendMessage({ text: intro });
    } catch {
      setToast("Could not read file");
      window.setTimeout(() => setToast(null), 4000);
    }
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20">
            <Sparkles className="h-5 w-5 text-indigo-300" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-zinc-100">Worklin</h1>
            <p className="text-xs text-zinc-500">Autonomous retention marketer</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              className="h-9 gap-1 border-white/15 text-xs"
              onClick={() => setPickerOpen((v) => !v)}
            >
              Chats <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </Button>
            {pickerOpen ? (
              <div className="absolute right-0 z-20 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-white/10 bg-zinc-900 py-1 shadow-xl">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-white/5"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-zinc-200"
                      onClick={() => void loadSession(s.id)}
                    >
                      {s.title || "New Chat"}
                    </button>
                    <button
                      type="button"
                      className="text-zinc-500 hover:text-red-400"
                      aria-label="Delete chat"
                      onClick={() => void deleteSession(s.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <Link
            href="/brain/learned"
            className="inline-flex h-9 items-center rounded-lg border border-white/15 bg-white/5 px-3 text-xs font-semibold text-zinc-100 hover:bg-white/10"
          >
            My Brain
          </Link>
          <Link
            href="/agent/workflows"
            className="inline-flex h-9 items-center rounded-lg border border-orange-300/25 bg-orange-300/10 px-3 text-xs font-semibold text-orange-100 hover:bg-orange-300/15"
          >
            Workflow Canvas
          </Link>
          <Button
            type="button"
            variant="outline"
            className="h-9 gap-1 border-white/15 text-xs"
            onClick={() => void handleNewChat()}
          >
            <Plus className="h-3.5 w-3.5" /> New Chat
          </Button>
        </div>
      </header>

      <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-4 ${canvasWorkflowId ? "lg:mr-[52vw]" : ""}`}>
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && !busy ? (
            <div className="rounded-2xl border border-indigo-300/20 bg-indigo-300/[0.06] p-5 text-zinc-100 shadow-2xl shadow-black/20">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-400/15">
                  <Sparkles className="h-5 w-5 text-indigo-200" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">Start with a retention audit</p>
                  <p className="mt-2 text-sm leading-6 text-zinc-300">
                    Want me to audit your retention setup? I can check products, campaigns, flows,
                    audiences, performance readiness, and lifecycle coverage, then tell you what needs fixing.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className="h-8 bg-indigo-600 px-3 text-xs hover:bg-indigo-500"
                      onClick={() => void runAuditStarter()}
                    >
                      Audit retention setup
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 border-white/15 px-3 text-xs"
                      onClick={() => setInput("Audit my retention setup")}
                    >
                      Put it in chat
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {messages.map((m) => {
            const isUser = m.role === "user";
            return (
              <div key={m.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm ${
                    isUser ? "bg-indigo-600/25 text-zinc-100" : "border border-white/10 bg-white/[0.03] text-zinc-100"
                  }`}
                >
                  {!isUser ? (
                    <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                      <Brain className="h-3.5 w-3.5 text-indigo-400" />
                      Worklin
                    </div>
                  ) : null}
                  {(() => {
                    const textBlocks = getRenderableTextParts(m.parts);
                    if (m.role === "assistant" && textBlocks.length === 0) {
                      const raw = m.parts
                        .map((part) => {
                          const any = part as { type?: string; text?: string; output?: unknown };
                          if (typeof any.text === "string" && any.text) return any.text;
                          return "";
                        })
                        .filter(Boolean)
                        .join("\n");
                      if (raw) {
                        return (
                          <div key="fallback" className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap">
                            {raw}
                          </div>
                        );
                      }
                    }
                    return (
                      <>
                        {textBlocks.map((block) => (
                          <div
                            key={block.key}
                            className={
                              block.kind === "reasoning"
                                ? "mt-2 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-zinc-400 italic"
                                : "prose prose-invert prose-sm max-w-none"
                            }
                          >
                            {block.kind === "text" ? (
                              <ReactMarkdown>{block.text}</ReactMarkdown>
                            ) : (
                              <span className="whitespace-pre-wrap">{block.text}</span>
                            )}
                          </div>
                        ))}
                        {m.parts.map((part, i) => {
                          const toolLine = toolLineFromPart(part);
                          if (!toolLine) return null;
                          return (
                            <p key={`tool-${i}`} className="mt-2 text-xs text-zinc-500">
                              {toolLine}
                            </p>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              </div>
            );
          })}
          {showAuditStarterActions ? (
            <div className="flex justify-start">
              <div className="flex flex-wrap gap-2 pl-12">
                <Button
                  type="button"
                  className="h-8 bg-indigo-600 px-3 text-xs hover:bg-indigo-500"
                  onClick={() => void runAuditStarter()}
                >
                  Audit retention setup
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 border-white/15 px-3 text-xs"
                  onClick={() => setInput("Audit my retention setup")}
                >
                  Put it in chat
                </Button>
              </div>
            </div>
          ) : null}
          {busy ? (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">
                <p className="animate-pulse text-xs">{THINKING_ROTATION[thinkingIdx]}</p>
                <p className="mt-2 text-lg leading-none tracking-widest text-zinc-500">•••</p>
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      {canvasWorkflowId ? (
        <aside className="fixed bottom-0 right-0 top-16 z-30 hidden w-[52vw] min-w-[520px] flex-col border-l border-white/10 bg-zinc-950/95 shadow-2xl shadow-black/40 backdrop-blur lg:flex">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Canvas</p>
              <p className="mt-1 truncate text-sm font-semibold text-zinc-100">Workflow artifact</p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href={workflowUrl(canvasWorkflowId)}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 text-xs font-semibold text-zinc-100 hover:bg-white/10"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Full
              </Link>
              <Button
                type="button"
                variant="ghost"
                className="h-8 px-2 text-zinc-400 hover:text-zinc-100"
                onClick={() => setCanvasWorkflowId(null)}
                aria-label="Close canvas"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkflowCanvasById workflowId={canvasWorkflowId} embedded />
          </div>
        </aside>
      ) : null}

      {toast ? (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-500/90 px-4 py-2 text-xs text-white">
          {toast}
        </div>
      ) : null}

      <form
        onSubmit={onSubmit}
        className={`shrink-0 border-t border-white/10 bg-zinc-950/95 px-4 py-3 backdrop-blur ${canvasWorkflowId ? "lg:mr-[52vw]" : ""}`}
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <input ref={fileRef} type="file" className="hidden" accept=".txt,.md,.pdf,.doc,.docx" onChange={onFilePick} />
          <Button
            type="button"
            variant="ghost"
            className="shrink-0 text-zinc-400 hover:text-zinc-200"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            aria-label="Upload document"
          >
            <Paperclip className="h-5 w-5" />
          </Button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Worklin..."
            rows={1}
            className="min-h-[40px] flex-1 resize-none rounded-md border border-white/15 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 disabled:opacity-50"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSubmit(e);
              }
            }}
          />
          {aiBusy ? (
            <Button type="button" variant="outline" className="shrink-0 border-white/15" onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button type="submit" className="shrink-0 gap-1 bg-indigo-600 hover:bg-indigo-500" disabled={busy}>
              {commandBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
            </Button>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-zinc-600">
          Shift+Enter for newline · Paste long text or upload a file for document analysis
        </p>
      </form>
    </>
  );
}

export default function AgentPage() {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string | null; updatedAt: string }>>([]);
  const [loadingSession, setLoadingSession] = useState(true);

  const loadSessionsList = useCallback(async () => {
    const res = await fetch("/api/agent/sessions");
    const data = (await res.json()) as {
      sessions?: Array<{ id: string; title: string | null; updatedAt: string }>;
    };
    setSessions(data.sessions ?? []);
  }, []);

  const bootstrap = useCallback(async () => {
    setLoadingSession(true);
    try {
      const latest = await fetch("/api/agent/sessions?latest=1");
      const data = (await latest.json()) as { session: ChatSession | null };
      if (data.session) {
        setSession(data.session);
      } else {
        const created = await fetch("/api/agent/sessions", { method: "POST" });
        const createdJson = (await created.json()) as { session: ChatSession };
        setSession(createdJson.session);
      }
      await loadSessionsList();
    } finally {
      setLoadingSession(false);
    }
  }, [loadSessionsList]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (loadingSession || !session) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center text-zinc-400">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-zinc-950" key={session.id}>
      <AgentChatPanel
        session={session}
        onSessionChange={setSession}
        sessions={sessions}
        onReloadSessions={loadSessionsList}
      />
    </div>
  );
}
