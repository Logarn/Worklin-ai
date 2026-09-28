import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { pushSseEvent, resetSseDebugStateForTests } from "./stream-debug";
import { clearStreamTiming, getStreamTimingSnapshot, recordStreamChunk, recordStreamHandler, tracedStreamFetch } from "./stream-timing";

beforeEach(() => {
  resetSseDebugStateForTests();
  window.history.replaceState({}, "", "/?streamTrace=1");
});
afterEach(() => {
  clearStreamTiming();
  window.history.replaceState({}, "", "/");
});

function envelope(seq: number): AssistantEventEnvelope {
  return {
    id: `event-${seq}`, seq, conversationId: "conv-test",
    emittedAt: new Date(1000 + seq).toISOString(),
    message: { type: "assistant_text_delta", messageId: "msg-test", text: "hi" },
  };
}

test("whole-message counters survive event ring eviction", () => {
  recordStreamChunk("client");
  for (let i = 0; i < 1500; i++) {
    if (i === 800) recordStreamChunk("client");
    pushSseEvent("client", envelope(i));
    recordStreamHandler(envelope(i), 2);
  }
  expect(getStreamTimingSnapshot()).toMatchObject({
    textEventCount: 1500, textCharacters: 3000, serverFirstMs: 1000,
    serverSpanMs: 1499, rawChunkCount: 2, handlerTotalMs: 3000, handlerMaxMs: 2,
  });
});

test("disabled tracing does not collect message counters", () => {
  window.history.replaceState({}, "", "/");
  pushSseEvent("client", envelope(1));
  expect(getStreamTimingSnapshot().messageId).toBeUndefined();
});

test("fetch instrumentation preserves streamed bytes and cancellation", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: hello\n\n")); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const fetcher = Object.assign(async () => response, { preconnect: fetch.preconnect });
  const traced = await tracedStreamFetch("client", fetcher)("https://example.com");
  const reader = traced.body!.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value)).toBe("data: hello\n\n");
  pushSseEvent("client", envelope(1));
  expect(getStreamTimingSnapshot().rawChunkCount).toBe(1);
  await reader.cancel();
  expect(cancelled).toBe(true);
});
