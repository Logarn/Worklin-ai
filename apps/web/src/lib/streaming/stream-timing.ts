/** Opt-in, constant-work stream measurements. No response text is retained. */
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

const requestedAtLoad = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("streamTrace") === "1";

export function streamTraceEnabled(): boolean {
  return requestedAtLoad || (typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("streamTrace") === "1");
}

interface Timing {
  messageId: string;
  conversationId?: string;
  textEventCount: number;
  textCharacters: number;
  serverFirstMs: number;
  serverLastMs: number;
  parsedFirstMs: number;
  parsedLastMs: number;
  rawFirstMs: number | null;
  rawLastMs: number | null;
  rawChunkCount: number;
  lastChunkId: number;
  handlerTotalMs: number;
  handlerMaxMs: number;
  renderCommitCount: number;
  renderFirstMs: number | null;
  renderLastMs: number | null;
  renderedTextLength: number;
}

const timings = new Map<string, Timing>();
const chunks = new Map<string, { id: number; at: number }>();
let latest: Timing | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let rawChunkId = 0;

export function recordStreamChunk(clientId: string): void {
  chunks.set(clientId, { id: ++rawChunkId, at: performance.now() });
  if (chunks.size > 20) chunks.delete(chunks.keys().next().value!);
}

/** Measures when JavaScript reads bytes, not when the network stack receives them. */
export function tracedStreamFetch(clientId: string, fetcher: typeof fetch): typeof fetch {
  const traced = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher(input, init);
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            controller.close();
          } else {
            recordStreamChunk(clientId);
            controller.enqueue(value);
          }
        } catch (error) {
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
  return Object.assign(traced, { preconnect: fetcher.preconnect });
}

export function recordStreamParsed(clientId: string, envelope: AssistantEventEnvelope): void {
  if (!streamTraceEnabled() || envelope.message.type !== "assistant_text_delta") return;
  const event = envelope.message;
  if (!event.messageId) return;
  const key = JSON.stringify([envelope.conversationId, event.messageId]);
  const at = performance.now();
  const serverAt = Date.parse(envelope.emittedAt);
  const chunk = chunks.get(clientId);
  let timing = timings.get(key);
  if (!timing) {
    timing = {
      messageId: event.messageId, conversationId: envelope.conversationId,
      textEventCount: 0, textCharacters: 0,
      serverFirstMs: serverAt, serverLastMs: serverAt,
      parsedFirstMs: at, parsedLastMs: at,
      rawFirstMs: chunk?.at ?? null, rawLastMs: null,
      rawChunkCount: 0, lastChunkId: -1,
      handlerTotalMs: 0, handlerMaxMs: 0,
      renderCommitCount: 0, renderFirstMs: null, renderLastMs: null,
      renderedTextLength: 0,
    };
    timings.set(key, timing);
    if (timings.size > 16) timings.delete(timings.keys().next().value!);
  }
  latest = timing;
  timing.textEventCount++;
  timing.textCharacters += event.text.length;
  timing.serverLastMs = serverAt;
  timing.parsedLastMs = at;
  if (chunk && chunk.id !== timing.lastChunkId) {
    timing.rawChunkCount++;
    timing.lastChunkId = chunk.id;
    timing.rawLastMs = chunk.at;
  }
  scheduleSnapshot();
}

export function recordStreamHandler(envelope: AssistantEventEnvelope, elapsedMs: number): void {
  if (envelope.message.type !== "assistant_text_delta") return;
  const timing = timings.get(JSON.stringify([envelope.conversationId, envelope.message.messageId]));
  if (!timing) return;
  timing.handlerTotalMs += elapsedMs;
  timing.handlerMaxMs = Math.max(timing.handlerMaxMs, elapsedMs);
}

export function recordStreamRender(input: {
  conversationId: string | null; messageId: string | null; textLength: number;
}): void {
  const timing = timings.get(JSON.stringify([input.conversationId, input.messageId]));
  if (timing) {
    const at = performance.now();
    timing.renderCommitCount++;
    timing.renderFirstMs ??= at;
    timing.renderLastMs = at;
    timing.renderedTextLength = input.textLength;
  }
  scheduleSnapshot();
}

export function getStreamTimingSnapshot() {
  return {
    enabled: streamTraceEnabled(),
    clock: "performance.now; server interval uses emittedAt",
    ...latest,
    renderCommitCount: latest?.renderCommitCount ?? 0,
    serverSpanMs: latest ? latest.serverLastMs - latest.serverFirstMs : null,
    parsedSpanMs: latest ? latest.parsedLastMs - latest.parsedFirstMs : null,
    rawSpanMs: latest?.rawFirstMs != null && latest.rawLastMs != null
      ? latest.rawLastMs - latest.rawFirstMs : null,
    finalParseAfterRawMs: latest?.rawLastMs != null
      ? latest.parsedLastMs - latest.rawLastMs : null,
    finalRenderAfterParseMs: latest?.renderLastMs != null
      ? latest.renderLastMs - latest.parsedLastMs : null,
  };
}

function scheduleSnapshot(): void {
  if (timer !== undefined || !streamTraceEnabled()) return;
  timer = setTimeout(() => {
    timer = undefined;
    publishStreamTimingSnapshot();
  }, 250);
}

export function publishStreamTimingSnapshot(): void {
  if (streamTraceEnabled() && typeof document !== "undefined") {
    document.documentElement.dataset.streamTrace = JSON.stringify(getStreamTimingSnapshot());
  }
}

export function clearStreamTiming(): void {
  clearTimeout(timer);
  timer = undefined;
  timings.clear();
  chunks.clear();
  latest = undefined;
  rawChunkId = 0;
}
