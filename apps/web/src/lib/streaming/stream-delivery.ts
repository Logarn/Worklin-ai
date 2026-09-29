/** Delivers delta bursts in one task so React can commit once per batch. */
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

const DELIVERY_INTERVAL_MS = 40;
const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_CHARACTERS = 64 * 1024;

export function createStreamDelivery(deliver: (event: AssistantEventEnvelope) => void) {
  let pending: AssistantEventEnvelope[] = [];
  let characters = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deltaKey: string | null = null;
  let cancelled = false;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    characters = 0;
    for (const envelope of batch) {
      if (cancelled) break;
      deliver(envelope);
    }
  }

  return {
    push(envelope: AssistantEventEnvelope) {
      if (cancelled) return;
      const event = envelope.message;
      if (event.type !== "assistant_text_delta" && event.type !== "assistant_thinking_delta") {
        flush();
        deltaKey = null;
        if (!cancelled) deliver(envelope);
        return;
      }
      const key = JSON.stringify([envelope.conversationId, event.type, event.messageId]);
      if (key !== deltaKey) {
        flush();
        deltaKey = key;
        if (!cancelled) deliver(envelope);
        return;
      }
      pending.push(envelope);
      characters += event.type === "assistant_text_delta" ? event.text.length : event.thinking.length;
      if (pending.length >= MAX_PENDING_EVENTS || characters >= MAX_PENDING_CHARACTERS) {
        flush();
      } else if (timer === undefined) {
        timer = setTimeout(flush, DELIVERY_INTERVAL_MS);
      }
    },
    flush,
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      timer = undefined;
      pending = [];
      characters = 0;
    },
  };
}
